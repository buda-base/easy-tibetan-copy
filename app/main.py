"""FastAPI application: API + static SPA.

Flow:
  POST /api/analyze   upload a PDF (<=5MB) -> inspect fonts, stage bytes, return token
  POST /api/jobs      {token, mode, pages} -> enqueue
  GET  /api/jobs/{id} poll status / queue position / result
  GET  /api/jobs/{id}/download  stream the fixed PDF, then evict from memory
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import processing
from .queue_manager import QueueFull, manager

MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # 5 MB
WEB_DIR = Path(__file__).resolve().parent.parent / "web"


@asynccontextmanager
async def lifespan(app: FastAPI):
    await manager.start()
    try:
        yield
    finally:
        await manager.stop()


app = FastAPI(title="Tibetan PDF Fix", version="0.1.0", lifespan=lifespan)


def _safe_stem(filename: str) -> str:
    stem = Path(filename or "document").stem
    stem = "".join(c for c in stem if c.isalnum() or c in (" ", "-", "_")).strip()
    return stem or "document"


async def _read_capped(upload: UploadFile) -> bytes:
    """Read an upload, rejecting anything over the size limit without buffering it all."""
    chunks = []
    total = 0
    while True:
        chunk = await upload.read(64 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File is too large. The limit is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
            )
        chunks.append(chunk)
    return b"".join(chunks)


@app.get("/api/config")
async def config():
    return {
        "max_upload_mb": MAX_UPLOAD_BYTES // (1024 * 1024),
        "max_queue": 50,
    }


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)):
    data = await _read_capped(file)
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if not processing.looks_like_pdf(data):
        raise HTTPException(status_code=400, detail="This does not look like a PDF file.")

    loop = asyncio.get_running_loop()
    import tempfile

    fd, tmp = tempfile.mkstemp(suffix=".pdf")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        try:
            analysis = await loop.run_in_executor(None, processing.analyze_pdf, tmp)
        except processing.ProcessingError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

    token = manager.stage(file.filename or "document.pdf", data, analysis)
    return {"token": token, "filename": file.filename, "analysis": analysis}


@app.post("/api/jobs")
async def create_job(payload: dict = Body(...)):
    token = payload.get("token")
    if not token:
        raise HTTPException(status_code=400, detail="Missing upload token.")
    pending = manager.take_pending(token)
    if not pending:
        raise HTTPException(
            status_code=410,
            detail="This upload expired. Please select the file again.",
        )

    mode = payload.get("mode", "fix")
    if mode not in ("fix", "extract"):
        mode = "fix"
    options = {
        "mode": mode,
        "pages": payload.get("pages", "all"),
    }
    try:
        result = await manager.enqueue(pending.filename, pending.data, options)
    except QueueFull:
        raise HTTPException(
            status_code=503,
            detail="The queue is full (50 documents waiting). Please try again in a moment.",
        )
    return result


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    status = manager.status(job_id)
    if status is None:
        raise HTTPException(status_code=404, detail="Unknown or expired job.")
    return status


_DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


@app.get("/api/jobs/{job_id}/download")
async def job_download(job_id: str, format: str = "pdf"):
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown or expired job.")
    if job.status != "done" or not job.result:
        raise HTTPException(status_code=409, detail="Nothing to download for this job.")

    res = job.result
    stem = _safe_stem(job.filename)

    if format == "docx" and res.get("kind") == "text":
        data = res.get("docx_bytes")
        if not data:
            raise HTTPException(status_code=409, detail="No Word document for this job.")
        content, media, filename = data, _DOCX_MEDIA, f"{stem}.docx"
    elif res.get("kind") == "pdf":
        content, media, filename = res.get("pdf_bytes"), "application/pdf", f"{stem}.fixed.pdf"
    else:
        raise HTTPException(status_code=409, detail="No matching download for this job.")

    # Hand the bytes to the response, then evict the job — nothing kept after download.
    manager.evict(job_id)
    return Response(
        content=content,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --- static SPA -------------------------------------------------------------- #


@app.get("/")
async def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="static")
