# Remote & Hosted Video Generation Options for Stage 2 (EffectErase)

Stage 1 (**SAM 2**) runs locally on ~4 GB VRAM, whereas Stage 2 (**EffectErase** built on `Wan2.1-Fun-1.3B-InP`) requires ~19 GB of checkpoints and 16–24 GB+ VRAM for full inference.

Because Stage 2 is isolated behind `EffectEraseAdapter` in [`backend/core/effect_erase_adapter.py`](../backend/core/effect_erase_adapter.py), the subprocess call can be swapped for a remote HTTP/API backend without changing the frontend, SAM 2 pipeline, or audio-muxing/validation logic.

> **License Reminder:** Upstream EffectErase weights and code are released under **CC BY-NC 4.0** (non-commercial research and educational use only).

---

## 1. Free Options (For Demos & Development)

| Platform | Free Allowance | Hardware | Pros | Cons / Caveats |
| :--- | :--- | :--- | :--- | :--- |
| **Modal** (`modal.com`) | ~$30/month free credits | L4 (24 GB), A10G (24 GB), L40S (48 GB) | Real HTTPS endpoint (`@modal.fastapi_endpoint`), scales to zero, persistent `modal.Volume` for ~19 GB weights, no notebook timeouts | Usually requires a payment method for account verification (not charged within free credits) |
| **Kaggle Notebooks** + `cloudflared` | ~30 GPU hours/week | T4 × 2 (32 GB total) or P100 (16 GB) | **No credit card required**, generous weekly quota | 12-hour session cap; requires running a FastAPI server + `cloudflared` quick tunnel; weights must be mounted/downloaded per session |
| **Lightning AI Studios** | ~15 credits/month (~22 hrs) | T4 (16 GB) | Persistent storage (keep checkpoints across sessions) | 16 GB VRAM requires DiffSynth `enable_vram_management` CPU offloading and/or lower resolution (`480×832`) |
| **Hugging Face Spaces (ZeroGPU)** | Up to 2 free ZeroGPU Spaces | Dynamic high-VRAM GPUs | Free high-VRAM inference without managing servers | Requires **Gradio SDK** (`gradio_client` from `stirs`); Space must be public |
| **Google Colab** | Ephemeral free tier | T4 (16 GB) | Quick to spin up with `cloudflared` | GPU availability not guaranteed; ~90 min idle disconnect; 16 GB VRAM requires offloading |

### Recommended Free Demo Setups
- **With card verification:** Deploy `external/EffectErase` on **Modal** with weights stored on a `modal.Volume` and have `EffectEraseAdapter` POST `(video, mask_video)` to the Modal endpoint.
- **100% card-free:** Run a FastAPI wrapper inside a **Kaggle (T4 × 2)** notebook, expose it via `cloudflared tunnel --url http://localhost:8000`, and point `stirs` to the `*.trycloudflare.com` URL.

---

## 2. Paid / Serverless GPU Hosting (Self-Hosted EffectErase)

For reliable, low-latency, pay-per-second hosting of the exact `EffectErase` stack:

- **Modal (`modal.com`):** Best Python-first serverless GPU workflow; scale-to-zero billing per second of inference.
- **RunPod Serverless / Pods** or **Vast.ai:** Good for Dockerized workers or persistent 24 GB GPU instances (RTX 3090 / 4090 / L4 / A10G).
- **Replicate (Cog) / fal.ai Custom Serverless:** Package `external/EffectErase` as a Cog container for a managed async REST/webhook API (ensure compliance with CC BY-NC 4.0 before any public/commercial deployment).

---

## 3. Managed Video Inpainting APIs (Replacing EffectErase)

If replacing EffectErase with a third-party hosted model is acceptable, `EffectEraseAdapter` can call a managed API that accepts `(video, mask)` or a text prompt (note: neither fal.ai nor Replicate offers a permanent free API tier; both require prepaid/pay-as-you-go billing):

| Provider / Model | Input Style | Notes |
| :--- | :--- | :--- |
| **fal.ai — `fal-ai/void-video-inpainting`** | Video + Mask | Closest behavioral match to EffectErase: removes objects along with secondary physical effects (shadows, reflections). |
| **Replicate — `jd7h/propainter`** | Video + Mask | Fast, inexpensive flow-based video inpainting compatible with SAM 2 binary masks (does not do full generative shadow/effect removal). |
| **fal.ai / Replicate — BRIA Video Eraser** | Video + Text prompt | Text-driven erasure; does not directly consume SAM 2 masks. |
| **Runway API** | Video + Text prompt | Commercial video editing/removal SDK; prompt-driven rather than mask-driven. |

---

## 4. Local Low-VRAM Fallback

`external/EffectErase/diffsynth/pipelines/wan_video.py` includes DiffSynth's `enable_vram_management` for layerwise CPU↔GPU offloading. Combined with `tiled=True` and lower target resolution (`480×832`), this can reduce peak VRAM usage at the cost of high system RAM usage (32 GB+ recommended) and significantly slower inference.

---

## 5. Planned Integration Architecture in `stirs`

To support remote inference cleanly in future development:
1. Add a backend selector env var (e.g. `EFFECT_ERASE_BACKEND=local|remote`, plus `EFFECT_ERASE_REMOTE_URL` / auth token) in [`backend/config.py`](../backend/config.py).
2. Keep mask alignment, nearest-neighbor upscaling, binary mask-video encoding, output validation, and FFmpeg audio muxing local in [`backend/core/effect_erase_adapter.py`](../backend/core/effect_erase_adapter.py).
3. Replace only the subprocess execution step with an HTTP upload/poll call when `EFFECT_ERASE_BACKEND=remote`.
