"""In-process job queue: one PDF processed at a time, up to 50 waiting.

Design (see DECISIONS.md):
- A single worker coroutine drains an asyncio.Queue(maxsize=MAX_QUEUE).
- Blocking PDF work runs in the default thread pool so the event loop stays free.
- Job state + results live in memory only. The uploaded bytes are written to a
  temp file solely for the duration of processing, then deleted. PDF results are
  evicted immediately after download; everything else is swept after a TTL.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from . import processing

MAX_QUEUE = 50          # waiting slots (excludes the one being processed)
RESULT_TTL = 15 * 60    # seconds a finished result lives before being swept
JOB_MAX_AGE = 30 * 60   # hard cap on any job's lifetime
SWEEP_INTERVAL = 60     # seconds between sweeps
PENDING_TTL = 10 * 60   # staged (analyzed, not yet enqueued) uploads
MAX_PENDING = 100       # cap on staged uploads held in memory


class QueueFull(Exception):
    """Raised when all waiting slots are taken."""


@dataclass
class Pending:
    """An uploaded-and-analyzed file awaiting the user's processing choice."""
    token: str
    filename: str
    data: bytes
    analysis: dict
    created_at: float = field(default_factory=time.time)


@dataclass
class Job:
    id: str
    filename: str
    options: dict
    status: str = "queued"  # queued | processing | done | error
    created_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    error: Optional[str] = None
    result: Optional[dict] = None  # processing output (may hold pdf_bytes/text)
    data: Optional[bytes] = None   # uploaded bytes, dropped after processing


class JobManager:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[str] = asyncio.Queue(maxsize=MAX_QUEUE)
        self._jobs: dict[str, Job] = {}
        self._pending: dict[str, Pending] = {}  # staged uploads (token -> Pending)
        self._order: list[str] = []          # FIFO of queued job ids
        self._processing_id: Optional[str] = None
        self._worker_task: Optional[asyncio.Task] = None
        self._sweeper_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    # -- lifecycle ---------------------------------------------------------- #

    async def start(self) -> None:
        self._worker_task = asyncio.create_task(self._worker(), name="pdf-worker")
        self._sweeper_task = asyncio.create_task(self._sweeper(), name="job-sweeper")

    async def stop(self) -> None:
        for task in (self._worker_task, self._sweeper_task):
            if task:
                task.cancel()
        for task in (self._worker_task, self._sweeper_task):
            if task:
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    # -- staging (analyze, then choose options) ----------------------------- #

    def stage(self, filename: str, data: bytes, analysis: dict) -> str:
        # Bound memory: if too many staged, drop the oldest.
        if len(self._pending) >= MAX_PENDING:
            oldest = min(self._pending.values(), key=lambda p: p.created_at)
            self._pending.pop(oldest.token, None)
        token = uuid.uuid4().hex
        self._pending[token] = Pending(
            token=token, filename=filename, data=data, analysis=analysis
        )
        return token

    def take_pending(self, token: str) -> Optional[Pending]:
        return self._pending.pop(token, None)

    # -- enqueue ------------------------------------------------------------ #

    async def enqueue(self, filename: str, data: bytes, options: dict) -> dict:
        async with self._lock:
            if self._queue.full():
                raise QueueFull()
            job = Job(id=uuid.uuid4().hex, filename=filename, options=options, data=data)
            self._jobs[job.id] = job
            self._order.append(job.id)
            await self._queue.put(job.id)
            return {"job_id": job.id, **self._status_payload(job)}

    # -- status ------------------------------------------------------------- #

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def status(self, job_id: str) -> Optional[dict]:
        job = self._jobs.get(job_id)
        if not job:
            return None
        return self._status_payload(job)

    def _position(self, job_id: str) -> int:
        """1-based jobs ahead in line (0 = next/now). Includes the processing one."""
        if job_id not in self._order:
            return 0
        ahead = self._order.index(job_id)
        if self._processing_id is not None:
            ahead += 1
        return ahead

    def _status_payload(self, job: Job) -> dict:
        payload: dict[str, Any] = {
            "status": job.status,
            "filename": job.filename,
            "mode": job.options.get("mode", "fix"),
        }
        if job.status == "queued":
            payload["position"] = self._position(job.id)
            payload["queue_total"] = len(self._order) + (
                1 if self._processing_id else 0
            )
        elif job.status == "done" and job.result:
            res = job.result
            payload["result_kind"] = res.get("kind")
            if res.get("kind") == "pdf":
                payload["stats"] = res.get("stats")
                payload["size"] = res.get("size")
                payload["download_url"] = f"/api/jobs/{job.id}/download"
            elif res.get("kind") == "text":
                payload["text"] = res.get("text")
                payload["format"] = res.get("format")
                payload["page_count"] = res.get("page_count")
                payload["pages_used"] = res.get("pages_used")
                if res.get("docx_size"):
                    payload["docx_download_url"] = (
                        f"/api/jobs/{job.id}/download?format=docx"
                    )
        elif job.status == "error":
            payload["error"] = job.error
        return payload

    # -- worker ------------------------------------------------------------- #

    async def _worker(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            job_id = await self._queue.get()
            job = self._jobs.get(job_id)
            try:
                if job is None or job.data is None:
                    continue  # swept before it ran
                async with self._lock:
                    if job_id in self._order:
                        self._order.remove(job_id)
                    self._processing_id = job_id
                    job.status = "processing"

                tmp_path = None
                try:
                    fd, tmp_path = tempfile.mkstemp(suffix=".pdf")
                    with os.fdopen(fd, "wb") as fh:
                        fh.write(job.data)
                    result = await loop.run_in_executor(
                        None, processing.process, tmp_path, job.options
                    )
                    job.result = result
                    job.status = "done"
                except processing.ProcessingError as exc:
                    job.status = "error"
                    job.error = str(exc)
                except Exception as exc:  # unexpected — keep the worker alive
                    job.status = "error"
                    job.error = f"Unexpected error: {exc}"
                finally:
                    if tmp_path and os.path.exists(tmp_path):
                        os.remove(tmp_path)
                    job.data = None  # free the input bytes
                    job.finished_at = time.time()
            finally:
                async with self._lock:
                    if self._processing_id == job_id:
                        self._processing_id = None
                self._queue.task_done()

    # -- eviction ----------------------------------------------------------- #

    def evict(self, job_id: str) -> None:
        self._jobs.pop(job_id, None)

    async def _sweeper(self) -> None:
        while True:
            await asyncio.sleep(SWEEP_INTERVAL)
            now = time.time()
            stale = []
            for job in list(self._jobs.values()):
                if job.status in ("done", "error") and job.finished_at:
                    if now - job.finished_at > RESULT_TTL:
                        stale.append(job.id)
                elif now - job.created_at > JOB_MAX_AGE:
                    stale.append(job.id)
            for jid in stale:
                self._jobs.pop(jid, None)
            for tok in [
                p.token
                for p in list(self._pending.values())
                if now - p.created_at > PENDING_TTL
            ]:
                self._pending.pop(tok, None)


manager = JobManager()
