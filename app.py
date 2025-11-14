#!/usr/bin/env python3
"""
Production-ready Flask app for Emotional-AI.

Keep your static files in a `static/` folder at repo root (recommended),
but the app will still attempt to serve files from repo root if found there.

Deployment notes:
- Use gunicorn in production:
    gunicorn app:app --bind 0.0.0.0:$PORT --workers 2
- Recommended: use a Render Cron or external scheduler to call /admin/cleanup every 15 minutes
  instead of relying on the in-process APScheduler when running multiple gunicorn workers.
"""

from flask import Flask, request, jsonify, send_from_directory, abort
import os
import logging
from flask_cors import CORS
from dotenv import load_dotenv
import base64
import json
from datetime import datetime, timedelta
from apscheduler.schedulers.background import BackgroundScheduler
import google.generativeai as genai
import atexit
from werkzeug.utils import secure_filename

# -----------------------
# Config
# -----------------------
load_dotenv()

APP_ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_FOLDER = os.path.join(APP_ROOT, "static")

# Security / limits
MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_LENGTH_BYTES", 10 * 1024 * 1024))
ALLOWED_AUDIO_MIME = {"audio/wav", "audio/x-wav", "audio/wave", "audio/wav; codecs=1"}

# Scheduler config
SESSION_TIMEOUT = timedelta(minutes=int(os.getenv("SESSION_TIMEOUT_MINUTES", "30")))
CLEANUP_INTERVAL_MINUTES = int(os.getenv("CLEANUP_INTERVAL_MINUTES", "15"))

# Logging configuration
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger("emotional-ai")

# Flask app init
app = Flask(__name__, static_folder=STATIC_FOLDER)
CORS(app)

app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

# -----------------------
# Gemini / AI setup
# -----------------------
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if GEMINI_API_KEY:
    try:
        genai.configure(api_key=GEMINI_API_KEY)
        logger.info("Gemini configured.")
    except Exception as e:
        logger.exception("Failed to configure Gemini: %s", e)
else:
    logger.warning("GEMINI_API_KEY not set. API endpoints will return a 500 until configured.")

# -----------------------
# In-memory session store (keeps previous behavior)
# -----------------------
active_sessions = {}

# Emotion mapping (kept exactly as in original)
emotion_map = {
    'happy': 'happy', 'joyful': 'happy', 'pleased': 'happy', 'cheerful': 'happy',
    'sad': 'sad', 'unhappy': 'sad', 'sorrowful': 'sad', 'melancholy': 'sad',
    'angry': 'angry', 'frustrated': 'frustrated', 'irritated': 'frustrated',
    'fearful': 'fearful', 'afraid': 'fearful', 'anxious': 'nervous', 'worried': 'nervous',
    'surprised': 'surprised', 'shocked': 'surprised', 'amazed': 'surprised',
    'neutral': 'neutral', 'calm': 'calm', 'relaxed': 'calm', 'peaceful': 'calm',
    'confident': 'confident', 'assured': 'confident', 'certain': 'confident',
    'nervous': 'nervous', 'tense': 'nervous', 'uneasy': 'nervous',
    'excited': 'excited', 'enthusiastic': 'excited', 'energetic': 'excited'
}

default_result = {
    "emotion": "neutral",
    "confidence": 0.5,
    "voice_features": {
        "pitch": "medium",
        "pace": "moderate",
        "energy": "moderate",
        "clarity": "good"
    },
    "analysis": "Could not analyze audio. Please ensure clear speech is present."
}

# -----------------------
# Utility functions
# -----------------------
def decode_base64_audio(data_str: str):
    """
    Accepts either raw base64 or data URI (data:audio/wav;base64,...)
    Returns bytes or raises ValueError.
    """
    if not isinstance(data_str, str) or not data_str:
        raise ValueError("Audio data must be a non-empty base64 string.")
    if "," in data_str:
        _prefix, b64 = data_str.split(",", 1)
    else:
        b64 = data_str
    try:
        return base64.b64decode(b64)
    except Exception as e:
        raise ValueError("Invalid base64 audio.") from e

def cleanup_expired_sessions():
    now = datetime.now()
    expired = []
    for sid, sdata in list(active_sessions.items()):
        last = sdata.get("last_active")
        if last and (now - last) > SESSION_TIMEOUT:
            expired.append(sid)
    for sid in expired:
        del active_sessions[sid]
        logger.info("Expired session removed: %s", sid)
    return expired

# -----------------------
# Routes: static files & health
# -----------------------
@app.route("/health")
def health():
    return jsonify({"status": "ok", "gemini_configured": bool(GEMINI_API_KEY)}), 200

def try_send_static(filename, mimetype=None):
    """
    Serve from static/ first, then root. Returns response or aborts 404.
    """
    safe_name = secure_filename(filename)
    # Prefer static folder (recommended)
    static_path = os.path.join(STATIC_FOLDER, safe_name)
    if os.path.isfile(static_path):
        return send_from_directory(STATIC_FOLDER, safe_name, mimetype=mimetype)
    # fallback to repo root
    root_path = os.path.join(APP_ROOT, safe_name)
    if os.path.isfile(root_path):
        return send_from_directory(APP_ROOT, safe_name, mimetype=mimetype)
    abort(404)

@app.route("/")
def home():
    try:
        # serve index.html from static/ or root
        return try_send_static("index.html")
    except Exception as e:
        logger.exception("Error serving index.html: %s", e)
        return "Error loading page", 500

@app.route("/login.html")
def login():
    try:
        return try_send_static("login.html")
    except Exception as e:
        logger.exception("Error serving login.html: %s", e)
        return "Error loading page", 500

@app.route("/style.css")
def serve_css():
    return try_send_static("style.css", mimetype="text/css")

@app.route("/script.js")
def serve_js():
    return try_send_static("script.js", mimetype="application/javascript")

# -----------------------
# API endpoints
# -----------------------
@app.route("/api/check-status")
def check_status():
    return jsonify({"configured": bool(GEMINI_API_KEY)}), 200

@app.route("/api/analyze-chunk", methods=["POST"])
def analyze_chunk():
    try:
        data = request.get_json(force=True, silent=True)
        if not data or "audio" not in data:
            return jsonify({"error": "No audio data provided"}), 400

        audio_data = data["audio"]
        session_id = data.get("session_id", "default")

        if not GEMINI_API_KEY:
            logger.error("Gemini API key not configured.")
            return jsonify({"error": "API key not configured"}), 500

        # Decode audio
        try:
            audio_bytes = decode_base64_audio(audio_data)
        except ValueError as e:
            logger.warning("Invalid audio format: %s", e)
            return jsonify({"error": "Invalid audio data format"}), 400

        logger.info("Received audio: %d bytes (session=%s)", len(audio_bytes), session_id)

        # Prepare Gemini request
        try:
            model = genai.GenerativeModel("gemini-2.0-flash")
            audio_part = {"mime_type": "audio/wav", "data": audio_bytes}

            prompt = """Analyze the emotional content of this audio clip. 

Provide your analysis in the following JSON format:
{
    "primary_emotion": "",
    "confidence": 0-1,
    "voice_characteristics": {
        "pitch": "high/medium/low",
        "pace": "fast/moderate/slow",
        "energy": "high/moderate/low",
        "clarity": "excellent/good/fair/poor"
    },
    "explanation": ""
}
If no clear speech is detected, return neutral with low confidence.
"""

            response = model.generate_content([prompt, audio_part], request_options={"timeout": 30})
            response_text = (response.text or "").strip()
            logger.debug("Raw Gemini response: %s", response_text)

            # Extract JSON if wrapped in markdown code block
            if "```json" in response_text:
                s = response_text.find("```json") + 7
                e = response_text.find("```", s)
                response_text = response_text[s:e].strip() if e > s else response_text[s:].strip()
            elif "```" in response_text:
                s = response_text.find("```") + 3
                e = response_text.find("```", s)
                response_text = response_text[s:e].strip() if e > s else response_text[s:].strip()

            try:
                analysis = json.loads(response_text)
            except json.JSONDecodeError:
                logger.warning("Could not parse JSON from Gemini response; returning default result.")
                return jsonify(default_result), 200

            primary_emotion = (analysis.get("primary_emotion") or "neutral").lower()
            mapped_emotion = emotion_map.get(primary_emotion, "neutral")
            confidence = float(analysis.get("confidence", 0.5))
            voice_chars = analysis.get("voice_characteristics", {})

            result = {
                "emotion": mapped_emotion,
                "confidence": min(max(confidence, 0.0), 1.0),
                "voice_features": {
                    "pitch": voice_chars.get("pitch", "medium"),
                    "pace": voice_chars.get("pace", "moderate"),
                    "energy": voice_chars.get("energy", "moderate"),
                    "clarity": voice_chars.get("clarity", "good"),
                },
                "analysis": analysis.get("explanation", "Emotion detected from voice analysis"),
            }

            # Persist in-session results (bounded)
            if session_id not in active_sessions:
                active_sessions[session_id] = {"results": [], "last_active": datetime.now()}
            active_sessions[session_id]["last_active"] = datetime.now()
            active_sessions[session_id]["results"].append(result)
            if len(active_sessions[session_id]["results"]) > 5:
                active_sessions[session_id]["results"].pop(0)

            logger.info("Emotion detected: %s (conf=%.2f) for session %s", mapped_emotion, result["confidence"], session_id)
            return jsonify(result), 200

        except Exception as api_error:
            logger.exception("Gemini API processing error: %s", api_error)
            fallback = default_result.copy()
            fallback["analysis"] = f"Error: {str(api_error)}"
            return jsonify(fallback), 200

    except Exception as e:
        logger.exception("Unhandled error in analyze-chunk: %s", e)
        return jsonify({"error": "Server Error", "message": str(e)}), 500

@app.route("/api/end-session", methods=["POST"])
def end_session():
    try:
        data = request.get_json(force=True, silent=True) or {}
        session_id = data.get("session_id", "default")

        if session_id in active_sessions:
            del active_sessions[session_id]
            logger.info("Session %s ended", session_id)

        return jsonify({"message": "Session ended"}), 200
    except Exception as e:
        logger.exception("Error ending session: %s", e)
        return jsonify({"error": str(e)}), 500

# Admin endpoint for triggering cleanup (safe to call from a cron job)
@app.route("/admin/cleanup", methods=["POST", "GET"])
def admin_cleanup():
    # Optional: protect with a simple token if desired (set ADMIN_TOKEN env var)
    admin_token = os.getenv("ADMIN_TOKEN")
    if admin_token:
        provided = request.headers.get("Authorization") or request.args.get("token")
        if not provided or provided.replace("Bearer ", "") != admin_token:
            return jsonify({"error": "unauthorized"}), 401

    removed = cleanup_expired_sessions()
    return jsonify({"removed_sessions": removed, "count": len(removed)}), 200

# -----------------------
# Scheduler setup (only auto-start when running directly)
# -----------------------
scheduler = BackgroundScheduler()

def start_scheduler_if_needed():
    """
    Start the in-process scheduler only when running the app directly (not under gunicorn workers).
    For production with multiple workers, prefer using an external cron that calls /admin/cleanup.
    """
    try:
        # If the app is executed as __main__, start scheduler.
        # Gunicorn does not execute __main__ when using `gunicorn app:app`.
        scheduler.add_job(cleanup_expired_sessions, "interval", minutes=CLEANUP_INTERVAL_MINUTES, id="cleanup_sessions")
        scheduler.start()
        logger.info("Background scheduler started (in-process). Interval: %d minutes", CLEANUP_INTERVAL_MINUTES)
    except Exception as e:
        logger.exception("Failed to start scheduler: %s", e)

def shutdown_scheduler():
    try:
        if scheduler.running:
            scheduler.shutdown(wait=False)
            logger.info("Scheduler shut down.")
    except Exception as e:
        logger.exception("Error shutting down scheduler: %s", e)

atexit.register(shutdown_scheduler)

# Only start the scheduler in direct-run mode
if __name__ == "__main__":
    if not GEMINI_API_KEY:
        logger.warning("GEMINI_API_KEY not configured! Get one from https://aistudio.google.com/app/apikey")
    start_scheduler_if_needed()

    # Local dev server (debug controlled by env var)
    debug_mode = os.getenv("FLASK_DEBUG", "False").lower() in ("1", "true", "yes")
    host = os.getenv("FLASK_HOST", "0.0.0.0")
    port = int(os.getenv("FLASK_PORT", "5000"))
    logger.info("Starting Flask development server at http://%s:%d (debug=%s)", host, port, debug_mode)
    try:
        app.run(host=host, port=port, debug=debug_mode)
    except (KeyboardInterrupt, SystemExit):
        logger.info("Shutting down due to keyboard interrupt / system exit.")
        shutdown_scheduler()