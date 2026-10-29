import os
import json
import subprocess
from pathlib import Path
from typing import Dict, Any, Tuple, Optional
import cv2

def probe_video(video_path: str) -> Dict[str, Any]:
    """
    Probes video metadata using ffprobe with fallback to cv2.VideoCapture.
    Returns: {fps: float, frame_count: int, width: int, height: int, has_audio: bool}
    """
    video_path = str(video_path)
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video file not found at: {video_path}")

    # Try ffprobe first
    try:
        cmd = [
            "ffprobe",
            "-v", "error",
            "-show_entries", "stream=width,height,r_frame_rate,nb_frames,codec_type",
            "-of", "json",
            video_path
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
        probe_data = json.loads(result.stdout)
        streams = probe_data.get("streams", [])
        
        video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
        audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

        if video_stream is not None:
            width = int(video_stream["width"])
            height = int(video_stream["height"])
            r_fps = video_stream.get("r_frame_rate", "30/1")
            num, den = map(int, r_fps.split("/"))
            fps = float(num) / float(den) if den != 0 else 30.0

            nb_frames = video_stream.get("nb_frames")
            if nb_frames and nb_frames.isdigit():
                frame_count = int(nb_frames)
            else:
                # Count with cv2 if nb_frames not directly reported
                cap = cv2.VideoCapture(video_path)
                frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                cap.release()

            return {
                "fps": round(fps, 2),
                "frame_count": frame_count,
                "width": width,
                "height": height,
                "has_audio": audio_stream is not None
            }
    except Exception:
        pass

    # OpenCV Fallback
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Could not open video file with OpenCV: {video_path}")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(cap.get(cv2.CAP_PROP_FPS)) or 30.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()

    return {
        "fps": round(fps, 2),
        "frame_count": frame_count,
        "width": width,
        "height": height,
        "has_audio": False
    }


def extract_frames(video_path: str, output_dir: str, max_dimension: Optional[int] = None) -> int:
    """
    Extracts all frames of the video to sequential JPEG files (00000.jpg, 00001.jpg, etc.)
    Uses ffmpeg for optimal speed and exact frame extraction.
    Returns the total number of extracted frames.
    """
    video_path = str(video_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    output_pattern = str(output_dir / "%05d.jpg")

    scale_filter = []
    if max_dimension is not None:
        # Scale while maintaining aspect ratio, ensuring even dimensions
        scale_filter = [
            "-vf",
            f"scale='min({max_dimension},iw)':-2"
        ]

    cmd = [
        "ffmpeg",
        "-y",
        "-i", video_path,
        "-start_number", "0",
        "-q:v", "2"  # High JPEG quality for SAM 2
    ] + scale_filter + [output_pattern]

    subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

    extracted_files = list(output_dir.glob("*.jpg"))
    return len(extracted_files)
