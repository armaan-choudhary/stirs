"""
Standalone FastAPI server for running EffectErase on Google Colab Pro (L4 / A100)
and exposing it to your local `stirs` backend via a Cloudflare quick tunnel.

Usage in a Colab Pro notebook (Runtime -> Change runtime type -> L4 or A100):
  1. !git clone https://github.com/FudanCVL/EffectErase.git /content/EffectErase
  2. !pip install -q -r /content/EffectErase/requirements.txt fastapi uvicorn python-multipart
  3. !pip install -q --no-deps -e /content/EffectErase
  4. Download weights into /content/weights (see README / huggingface-cli)
  5. Run this server + cloudflared tunnel:
     !wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared
     !python colab_effect_erase_server.py &
     !cloudflared tunnel --url http://localhost:8000
"""

import os
import subprocess
import tempfile
from pathlib import Path

import uvicorn
from fastapi import FastAPI, UploadFile
from fastapi.responses import Response

WEIGHTS_ROOT = Path(os.environ.get("EFFECT_ERASE_WEIGHTS_DIR", "/content/weights"))
SCRIPT_PATH = Path(
    os.environ.get(
        "EFFECT_ERASE_SCRIPT",
        "/content/EffectErase/examples/remove_wan/infer_remove_wan.py",
    )
)

app = FastAPI(title="stirs EffectErase Colab Worker")


@app.post("/")
async def remove_object(
    fg_bg_video: UploadFile,
    mask_video: UploadFile,
    num_inference_steps: int = 50,
    height: int = 480,
    width: int = 832,
    num_frames: int = 81,
    frame_interval: int = 1,
    seed: int = 2025,
    cfg: float = 1.0,
    lora_alpha: float = 1.0,
    tiled: bool = True,
    use_teacache: bool = False,
):
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        fg_path = tmp / "fg_bg.mp4"
        mask_path = tmp / "mask.mp4"
        out_path = tmp / "output.mp4"

        fg_path.write_bytes(await fg_bg_video.read())
        mask_path.write_bytes(await mask_video.read())

        cmd = [
            "python",
            str(SCRIPT_PATH),
            "--fg_bg_path",
            str(fg_path),
            "--mask_path",
            str(mask_path),
            "--output_path",
            str(out_path),
            "--text_encoder_path",
            str(WEIGHTS_ROOT / "models_t5_umt5-xxl-enc-bf16.pth"),
            "--vae_path",
            str(WEIGHTS_ROOT / "Wan2.1_VAE.pth"),
            "--dit_path",
            str(WEIGHTS_ROOT / "diffusion_pytorch_model.safetensors"),
            "--image_encoder_path",
            str(WEIGHTS_ROOT / "models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth"),
            "--pretrained_lora_path",
            str(WEIGHTS_ROOT / "EffectErase.ckpt"),
            "--num_inference_steps",
            str(num_inference_steps),
            "--height",
            str(height),
            "--width",
            str(width),
            "--num_frames",
            str(num_frames),
            "--frame_interval",
            str(frame_interval),
            "--seed",
            str(seed),
            "--cfg",
            str(cfg),
            "--lora_alpha",
            str(lora_alpha),
        ]
        if tiled:
            cmd.append("--tiled")
        if use_teacache:
            cmd.append("--use_teacache")

        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0 or not out_path.exists():
            return Response(
                content=f"EffectErase failed (exit {proc.returncode}):\n{proc.stderr[-2000:]}",
                status_code=500,
                media_type="text/plain",
            )

        return Response(content=out_path.read_bytes(), media_type="video/mp4")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
