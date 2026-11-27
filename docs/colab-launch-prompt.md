# Prompt: Generate Google Colab Launcher Notebook for `stirs` (EffectErase)

Copy and paste the prompt below into Gemini (or Colab's AI assistant) to generate a complete, ready-to-run Google Colab notebook from scratch:

---

```markdown
Create a complete, self-contained Google Colab notebook (`.ipynb` or ordered Python/bash cells) to host the **EffectErase** video object removal backend for the `stirs` project on a Colab GPU (T4 16GB or L4/A100), exposed via a Cloudflare quick tunnel.

Requirements for the notebook:
1. **Cell 1 — Install Dependencies & Tunnel**:
   - Clone `https://github.com/FudanCVL/EffectErase.git` into `/content/EffectErase`.
   - Patch `/content/EffectErase/diffsynth/models/utils.py` (`sed -i 's/weights_only=True/weights_only=False/g'`) so PyTorch 2.6+ can load `EffectErase.ckpt`.
   - Install `/content/EffectErase/requirements.txt` plus `fastapi`, `uvicorn`, `python-multipart`, and `pip install --no-deps -e /content/EffectErase`.
   - Download `cloudflared-linux-amd64` to `/usr/local/bin/cloudflared` and `chmod +x` it.

2. **Cell 2 — Mount Google Drive & Download Weights (Cached)**:
   - Mount Google Drive at `/content/drive` (flush-left Python, no leading indentation).
   - Create `/content/drive/MyDrive/effect_erase_weights`.
   - Download `alibaba-pai/Wan2.1-Fun-1.3B-InP` via `huggingface_hub` (`huggingface-cli download`) into `/content/drive/MyDrive/effect_erase_weights`, and include a clear note/command for placing `EffectErase.ckpt` in the same directory.

3. **Cell 3 — Write FastAPI Inference Server (`/content/colab_effect_erase_server.py`)**:
   - Write a FastAPI app with a `POST /` endpoint accepting:
     - Multipart file uploads: `fg_bg_video: UploadFile`, `mask_video: UploadFile`
     - Query parameters: `num_inference_steps: int = 50`, `height: int = 480`, `width: int = 832`, `num_frames: int = 81`, `frame_interval: int = 1`, `seed: int = 2025`, `cfg: float = 1.0`, `lora_alpha: float = 1.0`, `tiled: bool = True`, `use_teacache: bool = False`
   - Run `/content/EffectErase/examples/remove_wan/infer_remove_wan.py` via `subprocess.run` using the weights in `EFFECT_ERASE_WEIGHTS_DIR` (`/content/drive/MyDrive/effect_erase_weights`), and return the generated `.mp4` with `media_type="video/mp4"`.

4. **Cell 4 — Launch Server & Print Tunnel URL**:
   - Use `%%bash` to start `uvicorn` (`python /content/colab_effect_erase_server.py`) in the background with `nohup ... > /content/server.log 2>&1 &`.
   - Start `/usr/local/bin/cloudflared tunnel --url http://localhost:8000` in the background (`nohup ... > /content/tunnel.log 2>&1 &`), `sleep 5`, and `grep` the `https://*.trycloudflare.com` URL from `/content/tunnel.log` so the cell finishes and prints the public URL cleanly without hanging.
   - Print the exact local command to start `stirs`:
     `EFFECT_ERASE_BACKEND=remote EFFECT_ERASE_REMOTE_URL="<url>" .venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000`
```
