import os
import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch

import config
from core.sam2_engine import SAM2MaskGenerator


def test_config_large_is_primary(monkeypatch):
    """Verify that SAM 2 Large is chosen as the primary model when available."""
    assert "large" in config.SAM2_VARIANTS
    assert "small" in config.SAM2_VARIANTS
    assert config.SAM2_VARIANTS["large"]["config"] == "configs/sam2.1/sam2.1_hiera_l.yaml"
    assert "sam2.1_hiera_large.pt" in config.SAM2_VARIANTS["large"]["checkpoint"]
    assert config.FALLBACK_SAM2_CONFIG == "configs/sam2.1/sam2.1_hiera_s.yaml"
    assert "sam2.1_hiera_small.pt" in config.FALLBACK_SAM2_CHECKPOINT


def test_config_fallback_to_small_when_large_missing(tmp_path, monkeypatch):
    """Verify determine_active_variant falls back to small when large checkpoint is missing."""
    ckpt_dir = tmp_path / "checkpoints" / "sam2"
    ckpt_dir.mkdir(parents=True)
    small_pt = ckpt_dir / "sam2.1_hiera_small.pt"
    small_pt.write_text("dummy small")

    monkeypatch.setattr(config, "SAM2_CHECKPOINTS_DIR", ckpt_dir)
    monkeypatch.delenv("SAM2_VARIANT", raising=False)

    variant = config.determine_active_variant()
    assert variant == "small"


def test_config_env_override(tmp_path, monkeypatch):
    """Verify SAM2_VARIANT environment variable can explicitly select variant."""
    ckpt_dir = tmp_path / "checkpoints" / "sam2"
    ckpt_dir.mkdir(parents=True)
    small_pt = ckpt_dir / "sam2.1_hiera_small.pt"
    large_pt = ckpt_dir / "sam2.1_hiera_large.pt"
    small_pt.write_text("dummy small")
    large_pt.write_text("dummy large")

    monkeypatch.setattr(config, "SAM2_CHECKPOINTS_DIR", ckpt_dir)
    monkeypatch.setenv("SAM2_VARIANT", "small")

    # Update variant paths for temporary directory
    monkeypatch.setitem(config.SAM2_VARIANTS["small"], "checkpoint", str(small_pt))
    monkeypatch.setitem(config.SAM2_VARIANTS["large"], "checkpoint", str(large_pt))

    variant = config.determine_active_variant()
    assert variant == "small"


def test_generator_fallback_to_small_on_oom(tmp_path):
    """Verify SAM2MaskGenerator switches from large to small when fallback is triggered."""
    ckpt_dir = tmp_path / "checkpoints" / "sam2"
    ckpt_dir.mkdir(parents=True)
    large_pt = ckpt_dir / "sam2.1_hiera_large.pt"
    small_pt = ckpt_dir / "sam2.1_hiera_small.pt"
    large_pt.write_text("dummy large")
    small_pt.write_text("dummy small")

    large_cfg = "configs/sam2.1/sam2.1_hiera_l.yaml"
    small_cfg = "configs/sam2.1/sam2.1_hiera_s.yaml"

    gen = SAM2MaskGenerator(
        config_path=large_cfg,
        checkpoint_path=str(large_pt),
        device="cpu",
        fallback_config_path=small_cfg,
        fallback_checkpoint_path=str(small_pt)
    )

    assert gen.variant == "large"
    assert gen.checkpoint_path == str(large_pt)

    # Trigger fallback
    success = gen._try_fallback_to_small(reason="Simulated CUDA Out Of Memory")
    assert success is True
    assert gen.variant == "small"
    assert gen.checkpoint_path == str(small_pt)
    assert gen.config_path == small_cfg

    # Repeated fallback on already small variant returns False
    second_attempt = gen._try_fallback_to_small(reason="Another error")
    assert second_attempt is False


def test_generator_load_model_retries_with_small_on_large_failure(tmp_path, monkeypatch):
    """Verify load_model automatically catches large failure and loads small."""
    ckpt_dir = tmp_path / "checkpoints" / "sam2"
    ckpt_dir.mkdir(parents=True)
    large_pt = ckpt_dir / "sam2.1_hiera_large.pt"
    small_pt = ckpt_dir / "sam2.1_hiera_small.pt"
    large_pt.write_text("dummy large")
    small_pt.write_text("dummy small")

    large_cfg = "configs/sam2.1/sam2.1_hiera_l.yaml"
    small_cfg = "configs/sam2.1/sam2.1_hiera_s.yaml"

    gen = SAM2MaskGenerator(
        config_path=large_cfg,
        checkpoint_path=str(large_pt),
        device="cpu",
        fallback_config_path=small_cfg,
        fallback_checkpoint_path=str(small_pt)
    )
    # Enable simulated real sam2 flag
    gen._is_real_sam2 = True

    calls = []

    def mock_build_predictor(cfg, ckpt, device=None, vos_optimized=True):
        calls.append(ckpt)
        if "large" in ckpt:
            raise RuntimeError("CUDA out of memory: tried to allocate 2.00 GiB")
        mock_pred = MagicMock()
        return mock_pred

    import core.sam2_engine as sam2_engine_module
    monkeypatch.setattr(sam2_engine_module, "build_sam2_video_predictor", mock_build_predictor)

    gen.load_model()
    assert gen.variant == "small"
    assert len(calls) == 2
    assert "large" in calls[0]
    assert "small" in calls[1]
    assert gen.predictor is not None
