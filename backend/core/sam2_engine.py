import os
import gc
import cv2
import logging
import ctypes
import numpy as np
from typing import Callable, Optional

logger = logging.getLogger("stirs.sam2_engine")


def release_system_memory():
    """Forces Python garbage collection, PyTorch CUDA cache flush, and glibc malloc_trim."""
    gc.collect()
    if TORCH_AVAILABLE and torch.cuda.is_available():
        torch.cuda.empty_cache()
    try:
        libc = ctypes.CDLL("libc.so.6")
        libc.malloc_trim(0)
    except Exception:
        pass


class JobCancelledException(Exception):
    """Raised when propagation is cancelled cooperatively."""
    pass

# Check if PyTorch is available
try:
    import torch
    TORCH_AVAILABLE = True
except ImportError:
    torch = None
    TORCH_AVAILABLE = False

# Check if SAM2 is available
try:
    from sam2.build_sam import build_sam2_video_predictor, build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor
    SAM2_AVAILABLE = True
except ImportError:
    SAM2_AVAILABLE = False
    build_sam2_video_predictor = None
    build_sam2 = None
    SAM2ImagePredictor = None


class SAM2MaskGenerator:
    """
    Optimized SAM 2 Video Predictor Wrapper with persistent model caching,
    bfloat16 mixed precision acceleration, and clean neural mask generation.
    """
    _instance: Optional["SAM2MaskGenerator"] = None

    @classmethod
    def get_instance(
        cls,
        config_path: str,
        checkpoint_path: str,
        device: str = "cuda",
        fallback_config_path: Optional[str] = None,
        fallback_checkpoint_path: Optional[str] = None,
    ) -> "SAM2MaskGenerator":
        """Singleton accessor to prevent reloading the model from disk on every preview/job request."""
        if cls._instance is None:
            cls._instance = cls(
                config_path=config_path,
                checkpoint_path=checkpoint_path,
                device=device,
                fallback_config_path=fallback_config_path,
                fallback_checkpoint_path=fallback_checkpoint_path,
            )
        elif cls._instance.checkpoint_path != checkpoint_path or cls._instance.config_path != config_path:
            cls._instance.unload_model()
            cls._instance = cls(
                config_path=config_path,
                checkpoint_path=checkpoint_path,
                device=device,
                fallback_config_path=fallback_config_path,
                fallback_checkpoint_path=fallback_checkpoint_path,
            )
        else:
            if fallback_config_path is not None:
                cls._instance.fallback_config_path = fallback_config_path
            if fallback_checkpoint_path is not None:
                cls._instance.fallback_checkpoint_path = fallback_checkpoint_path
        return cls._instance

    def __init__(
        self,
        config_path: str,
        checkpoint_path: str,
        device: str = "cuda",
        fallback_config_path: Optional[str] = None,
        fallback_checkpoint_path: Optional[str] = None,
    ):
        self.config_path = config_path
        self.checkpoint_path = checkpoint_path
        self.fallback_config_path = fallback_config_path
        self.fallback_checkpoint_path = fallback_checkpoint_path
        self.device = device if (TORCH_AVAILABLE and torch.cuda.is_available()) else "cpu"
        self.predictor = None
        self.image_predictor = None
        self._is_real_sam2 = SAM2_AVAILABLE and os.path.exists(checkpoint_path)
        self.variant = "large" if "large" in checkpoint_path else "small"
        self.amp_dtype = (
            torch.bfloat16 if (TORCH_AVAILABLE and torch.cuda.is_available() and torch.cuda.is_bf16_supported())
            else (torch.float16 if TORCH_AVAILABLE else None)
        )

    def _try_fallback_to_small(self, reason: str) -> bool:
        """
        Attempts to fall back from SAM 2 Large to SAM 2 Small when large is not feasible
        (e.g. CUDA OutOfMemory, insufficient VRAM, or corrupted/missing large checkpoint).
        """
        if self.variant != "large":
            return False

        fallback_ckpt = self.fallback_checkpoint_path
        fallback_cfg = self.fallback_config_path

        # If fallback checkpoint path wasn't provided, check default small path
        if not fallback_ckpt:
            ckpt_dir = os.path.dirname(self.checkpoint_path)
            candidate = os.path.join(ckpt_dir, "sam2.1_hiera_small.pt")
            if os.path.exists(candidate):
                fallback_ckpt = candidate
                fallback_cfg = "configs/sam2.1/sam2.1_hiera_s.yaml"

        if not fallback_ckpt or not os.path.exists(fallback_ckpt):
            logger.warning(
                f"SAM 2 Large is not feasible ({reason}), but fallback checkpoint is not available."
            )
            return False

        logger.warning(
            f"SAM 2 Large is not feasible ({reason}). "
            f"Gracefully falling back to SAM 2 Small ({fallback_ckpt})..."
        )

        self.unload_model()
        self.config_path = fallback_cfg or "configs/sam2.1/sam2.1_hiera_s.yaml"
        self.checkpoint_path = fallback_ckpt
        self.variant = "small"
        self._is_real_sam2 = SAM2_AVAILABLE and os.path.exists(fallback_ckpt)
        return True

    def load_model(self):
        """Loads video predictor onto GPU with vos_optimized=True for high-speed tracking."""
        if not self._is_real_sam2:
            return

        # Pre-emptive check: if free VRAM is critically low (< 1.2 GB), avoid OOM crash by falling back
        if self.variant == "large" and self.device == "cuda" and TORCH_AVAILABLE:
            try:
                free_mem, _ = torch.cuda.mem_get_info()
                if free_mem < 1.2 * (1024 ** 3):
                    self._try_fallback_to_small("insufficient free VRAM (< 1.2 GB available)")
            except Exception:
                pass

        if self.predictor is None:
            try:
                # Use standard eager inference without torch.compile (vos_optimized=False).
                # vos_optimized=True activates torch.compile with mode='max-autotune', which triggers
                # heavy JIT/Triton compilation that consumes 8-12 GB host RAM and maxes out swap/CPU.
                self.predictor = build_sam2_video_predictor(
                    self.config_path,
                    self.checkpoint_path,
                    device=self.device,
                    vos_optimized=False
                )
            except Exception as e:
                err_str = str(e).lower()
                is_oom = "out of memory" in err_str or (
                    TORCH_AVAILABLE and isinstance(e, getattr(torch.cuda, "OutOfMemoryError", ()))
                )
                if self.variant == "large" and self._try_fallback_to_small(f"loading error: {e}"):
                    self.predictor = build_sam2_video_predictor(
                        self.config_path,
                        self.checkpoint_path,
                        device=self.device,
                        vos_optimized=False
                    )
                else:
                    raise

    def load_image_predictor(self):
        """Loads single-image predictor for interactive instant preview."""
        if not self._is_real_sam2:
            return

        # Pre-emptive check: if free VRAM is critically low (< 1.0 GB), avoid OOM crash by falling back
        if self.variant == "large" and self.device == "cuda" and TORCH_AVAILABLE:
            try:
                free_mem, _ = torch.cuda.mem_get_info()
                if free_mem < 1.0 * (1024 ** 3):
                    self._try_fallback_to_small("insufficient free VRAM (< 1.0 GB available)")
            except Exception:
                pass

        if self.image_predictor is None:
            try:
                base_model = build_sam2(self.config_path, self.checkpoint_path, device=self.device)
                self.image_predictor = SAM2ImagePredictor(base_model)
            except Exception as e:
                err_str = str(e).lower()
                is_oom = "out of memory" in err_str or (
                    TORCH_AVAILABLE and isinstance(e, getattr(torch.cuda, "OutOfMemoryError", ()))
                )
                if self.variant == "large" and self._try_fallback_to_small(f"loading error: {e}"):
                    base_model = build_sam2(self.config_path, self.checkpoint_path, device=self.device)
                    self.image_predictor = SAM2ImagePredictor(base_model)
                else:
                    raise

    def unload_model(self):
        """Releases model memory and clears PyTorch CUDA cache."""
        if self.predictor is not None:
            del self.predictor
            self.predictor = None
        if self.image_predictor is not None:
            del self.image_predictor
            self.image_predictor = None
        release_system_memory()

    @staticmethod
    def dilate_mask(mask_bool: np.ndarray, dilation_px: int) -> np.ndarray:
        mask_uint8 = (mask_bool.astype(np.uint8)) * 255
        if dilation_px > 0:
            kernel = cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE, (dilation_px, dilation_px)
            )
            mask_uint8 = cv2.dilate(mask_uint8, kernel, iterations=1)
        return mask_uint8

    def _fallback_generate_mask(
        self,
        image_shape: tuple,
        box: Optional[np.ndarray],
        points: Optional[np.ndarray],
        labels: Optional[np.ndarray],
        frame_offset: int = 0
    ) -> np.ndarray:
        """
        Deterministic geometric approximation of object segmentation.
        Used for unit tests and environments without PyTorch/SAM 2 weights.
        Generates an ellipse for bounding boxes (translating over frames)
        and circles for positive/negative keypoints.
        """
        h, w = image_shape[:2]
        mask = np.zeros((h, w), dtype=np.uint8)

        if box is not None:
            if not isinstance(box, np.ndarray):
                box = np.array(box, dtype=np.float32)
            x1, y1, x2, y2 = box.astype(int)
            dx = int(frame_offset * 1.5)
            dy = int(frame_offset * 0.5)
            x1 = max(0, min(w - 1, x1 + dx))
            y1 = max(0, min(h - 1, y1 + dy))
            x2 = max(0, min(w - 1, x2 + dx))
            y2 = max(0, min(h - 1, y2 + dy))

            center = ((x1 + x2) // 2, (y1 + y2) // 2)
            axes = (max(5, (x2 - x1) // 2), max(5, (y2 - y1) // 2))
            cv2.ellipse(mask, center, axes, 0, 0, 360, 255, -1)

        if points is not None and len(points) > 0 and labels is not None:
            for pt, lbl in zip(points, labels):
                if isinstance(pt, dict):
                    px, py = int(pt.get("x", 0)), int(pt.get("y", 0))
                elif hasattr(pt, "x") and hasattr(pt, "y"):
                    px, py = int(pt.x), int(pt.y)
                else:
                    px, py = int(pt[0]), int(pt[1])
                val = 255 if int(lbl) == 1 else 0
                cv2.circle(mask, (px, py), 20, val, -1)

        return mask > 0

    def preview_single_frame(
        self,
        frames_dir: str,
        frame_idx: int,
        box: Optional[np.ndarray] = None,
        points: Optional[np.ndarray] = None,
        labels: Optional[np.ndarray] = None,
        multi_objects: Optional[list] = None,
        dilation_px: int = 7
    ) -> np.ndarray:
        """
        Fast interactive preview (<150ms).
        Reuses cached predictor with bfloat16/fp16 mixed precision.
        Supports single prompt set or multiple object prompts via multi_objects:
        multi_objects is a list of (obj_id, box, points, labels) tuples or dicts.
        """
        frame_files = sorted([f for f in os.listdir(frames_dir) if f.endswith(('.jpg', '.jpeg', '.png'))])
        if not frame_files:
            raise FileNotFoundError(f"No frames found in {frames_dir}")

        target_file = frame_files[min(frame_idx, len(frame_files) - 1)]
        sample_img = cv2.imread(os.path.join(frames_dir, target_file))
        if sample_img is None:
            raise RuntimeError(f"Could not read frame {target_file}")

        # Prepare list of object prompts: each is (box, points, labels)
        prompts = []
        if multi_objects is not None and len(multi_objects) > 0:
            for item in multi_objects:
                if isinstance(item, (tuple, list)):
                    # Format: (obj_id, b, p, l) or (b, p, l)
                    if len(item) == 4:
                        _, b, p, l = item
                    elif len(item) == 3:
                        b, p, l = item
                    else:
                        continue
                elif isinstance(item, dict):
                    b = item.get("box") if "box" in item else item.get("bbox")
                    p = item.get("points")
                    l = item.get("labels")
                else:
                    continue

                if b is not None and not isinstance(b, np.ndarray):
                    b = np.array(b, dtype=np.float32)
                if p is not None:
                    if isinstance(p, list) and len(p) > 0:
                        first_elem = p[0]
                        if isinstance(first_elem, dict):
                            p = [[pt.get("x", 0), pt.get("y", 0)] for pt in p]
                        elif hasattr(first_elem, "x") and hasattr(first_elem, "y"):
                            p = [[pt.x, pt.y] for pt in p]
                    if not isinstance(p, np.ndarray):
                        p = np.array(p, dtype=np.float32)
                if l is not None and not isinstance(l, np.ndarray):
                    l = np.array(l, dtype=np.int32)

                prompts.append((b, p, l))
        elif box is not None or (points is not None and len(points) > 0):
            if box is not None and not isinstance(box, np.ndarray):
                box = np.array(box, dtype=np.float32)
            if points is not None and not isinstance(points, np.ndarray):
                points = np.array(points, dtype=np.float32)
            if labels is not None and not isinstance(labels, np.ndarray):
                labels = np.array(labels, dtype=np.int32)
            prompts.append((box, points, labels))

        if not prompts:
            # Empty mask if no prompts provided
            return np.zeros((sample_img.shape[0], sample_img.shape[1]), dtype=np.uint8)

        combined_mask_bool = np.zeros((sample_img.shape[0], sample_img.shape[1]), dtype=bool)

        if self._is_real_sam2 and TORCH_AVAILABLE:
            try:
                autocast_ctx = (
                    torch.autocast("cuda", dtype=self.amp_dtype)
                    if (self.device == "cuda" and self.amp_dtype is not None)
                    else torch.inference_mode()
                )
                with torch.inference_mode(), autocast_ctx:
                    self.load_image_predictor()
                    rgb_img = cv2.cvtColor(sample_img, cv2.COLOR_BGR2RGB)
                    self.image_predictor.set_image(rgb_img)

                    for b, p, l in prompts:
                        pts_arg = p if (p is not None and len(p) > 0) else None
                        labels_arg = l if (l is not None and len(l) > 0) else None
                        box_arg = b if b is not None else None

                        masks, _, _ = self.image_predictor.predict(
                            point_coords=pts_arg,
                            point_labels=labels_arg,
                            box=box_arg,
                            multimask_output=False
                        )
                        combined_mask_bool = np.logical_or(combined_mask_bool, masks[0] > 0.0)

                    return self.dilate_mask(combined_mask_bool, dilation_px)
            except Exception as e:
                err_str = str(e).lower()
                is_oom = "out of memory" in err_str or (
                    TORCH_AVAILABLE and isinstance(e, getattr(torch.cuda, "OutOfMemoryError", ()))
                )
                if self.variant == "large" and self._try_fallback_to_small(f"preview exception: {e}"):
                    return self.preview_single_frame(
                        frames_dir=frames_dir,
                        frame_idx=frame_idx,
                        box=box,
                        points=points,
                        labels=labels,
                        multi_objects=multi_objects,
                        dilation_px=dilation_px
                    )
                import traceback
                traceback.print_exc()
                for b, p, l in prompts:
                    obj_mask = self._fallback_generate_mask(sample_img.shape, b, p, l, frame_offset=0)
                    combined_mask_bool = np.logical_or(combined_mask_bool, obj_mask)
                return self.dilate_mask(combined_mask_bool, dilation_px)
        else:
            for b, p, l in prompts:
                obj_mask = self._fallback_generate_mask(sample_img.shape, b, p, l, frame_offset=0)
                combined_mask_bool = np.logical_or(combined_mask_bool, obj_mask)
            return self.dilate_mask(combined_mask_bool, dilation_px)

    def propagate_full_video(
        self,
        frames_dir: str,
        output_mask_dir: str,
        annotated_frame_idx: int = 0,
        box: Optional[np.ndarray] = None,
        points: Optional[np.ndarray] = None,
        labels: Optional[np.ndarray] = None,
        keyframe_prompts: Optional[list] = None,
        dilation_px: int = 7,
        accumulate: bool = False,
        progress_cb: Optional[Callable[[str, int], None]] = None,
        cancel_check: Optional[Callable[[], bool]] = None,
        existing_mask_dir: Optional[str] = None
    ) -> str:
        """
        Runs high-speed bidirectional propagation using persistent predictor and bfloat16 AMP.
        Supports multi-object tracking and multi-keyframe conditioning prompts.
        Saves clean, precise neural masks.
        Supports cooperative cancellation via `cancel_check`.
        When SAM 2 weights or CUDA are unavailable, executes a deterministic geometric fallback approximation.
        """
        if cancel_check and cancel_check():
            raise JobCancelledException("Job was cancelled before propagation started.")

        os.makedirs(output_mask_dir, exist_ok=True)
        frame_files = sorted([f for f in os.listdir(frames_dir) if f.endswith(('.jpg', '.jpeg', '.png'))])
        total_frames = len(frame_files)
        if total_frames == 0:
            raise FileNotFoundError(f"No frames in {frames_dir}")

        segments = {}

        # Standardize keyframe prompts structure:
        # list of dicts: {"frame_idx": int, "objects": [(obj_id, box, pts, lbls), ...]}
        standardized_keyframes = []
        raw_kps = keyframe_prompts if keyframe_prompts else [{
            "frame_idx": annotated_frame_idx,
            "objects": [(1, box, points, labels)]
        }]

        for kp in raw_kps:
            f_idx = kp.get("frame_idx", kp.get("frame_index", kp.get("frame", annotated_frame_idx)))
            raw_objs = kp.get("objects", [])
            if not raw_objs and ("box" in kp or "points" in kp):
                raw_objs = [kp]

            std_objs = []
            for obj_idx, obj in enumerate(raw_objs, start=1):
                if isinstance(obj, (tuple, list)):
                    if len(obj) == 4:
                        oid, b, p, l = obj
                    elif len(obj) == 3:
                        b, p, l = obj
                        oid = obj_idx
                    else:
                        continue
                elif isinstance(obj, dict):
                    oid = obj.get("obj_id", obj.get("id", obj_idx))
                    b = obj.get("box") if "box" in obj else obj.get("bbox")
                    p = obj.get("points")
                    l = obj.get("labels")
                else:
                    continue

                if b is not None and not isinstance(b, np.ndarray):
                    b = np.array(b, dtype=np.float32)
                if p is not None:
                    if isinstance(p, list) and len(p) > 0:
                        first_elem = p[0]
                        if isinstance(first_elem, dict):
                            p = [[pt.get("x", 0), pt.get("y", 0)] for pt in p]
                        elif hasattr(first_elem, "x") and hasattr(first_elem, "y"):
                            p = [[pt.x, pt.y] for pt in p]
                    if not isinstance(p, np.ndarray):
                        p = np.array(p, dtype=np.float32)
                if l is not None and not isinstance(l, np.ndarray):
                    l = np.array(l, dtype=np.int32)

                std_objs.append((oid, b, p, l))

            if std_objs:
                standardized_keyframes.append({
                    "frame_idx": f_idx,
                    "objects": std_objs
                })

        if not standardized_keyframes:
            standardized_keyframes = [{
                "frame_idx": annotated_frame_idx,
                "objects": [(1, box, points, labels)]
            }]

        keyframe_prompts = sorted(standardized_keyframes, key=lambda kp: kp["frame_idx"])
        all_frame_indices = [kp["frame_idx"] for kp in keyframe_prompts]
        min_keyframe = max(0, min(min(all_frame_indices), total_frames - 1))
        saved_count = 0

        if self._is_real_sam2 and TORCH_AVAILABLE:
            try:
                autocast_ctx = (
                    torch.autocast("cuda", dtype=self.amp_dtype)
                    if (self.device == "cuda" and self.amp_dtype is not None)
                    else torch.inference_mode()
                )
                with torch.inference_mode(), autocast_ctx:
                    self.load_model()
                    # Check available VRAM to determine whether offloading to CPU RAM is necessary.
                    # On GPUs with >= 6 GB free VRAM (like RTX 5050 with 8 GB), keep state on GPU:
                    # - Drops system RAM usage from ~10-14 GB down to ~1.5-2.5 GB
                    # - Eliminates heavy PCIe transfer bottlenecks (15-30% faster tracking)
                    offload_state = True
                    offload_video = True
                    if self.device == "cuda" and TORCH_AVAILABLE and torch.cuda.is_available():
                        try:
                            free_vram, total_vram = torch.cuda.mem_get_info()
                            if free_vram >= 5.5 * (1024 ** 3):
                                offload_state = False
                                offload_video = False
                            elif free_vram >= 3.5 * (1024 ** 3):
                                offload_state = False
                                offload_video = True
                        except Exception:
                            pass

                    state = self.predictor.init_state(
                        video_path=frames_dir,
                        offload_video_to_cpu=offload_video,
                        offload_state_to_cpu=offload_state,
                        async_loading_frames=False
                    )

                    # Add all keyframe prompts into SAM 2 state
                    for kp in keyframe_prompts:
                        f_idx = kp["frame_idx"]
                        for (obj_id, b, pts, lbls) in kp["objects"]:
                            self.predictor.add_new_points_or_box(
                                inference_state=state,
                                frame_idx=f_idx,
                                obj_id=obj_id,
                                box=b,
                                points=pts,
                                labels=lbls
                            )

                    def process_and_save_frame(frame_idx_val: int, mask_tensor_or_bool):
                        if isinstance(mask_tensor_or_bool, torch.Tensor):
                            mask_bool = mask_tensor_or_bool.cpu().numpy()
                        else:
                            mask_bool = mask_tensor_or_bool

                        dilated = self.dilate_mask(mask_bool, dilation_px)
                        out_file = os.path.join(output_mask_dir, f"{frame_idx_val:05d}.png")
                        if accumulate:
                            read_dir = existing_mask_dir if existing_mask_dir is not None else output_mask_dir
                            source_file = os.path.join(read_dir, f"{frame_idx_val:05d}.png")
                            if os.path.exists(source_file):
                                existing_mask = cv2.imread(source_file, cv2.IMREAD_GRAYSCALE)
                                if existing_mask is not None and existing_mask.shape == dilated.shape:
                                    dilated = cv2.bitwise_or(existing_mask, dilated)
                        cv2.imwrite(out_file, dilated)

                    # Forward pass: from earliest keyframe -> End
                    for out_idx, obj_ids, logits in self.predictor.propagate_in_video(state, start_frame_idx=min_keyframe):
                        if cancel_check and cancel_check():
                            self.predictor.reset_state(state)
                            raise JobCancelledException("Job was cancelled during forward propagation.")
                        # logits shape: [num_objs, 1, H, W]
                        # Union masks across all tracked objects (subject + reflection/shadow)
                        mask_union = (logits > 0.0).any(dim=0).squeeze()
                        process_and_save_frame(out_idx, mask_union)
                        saved_count += 1
                        if progress_cb:
                            progress_cb("sam2_forward", int((saved_count / total_frames) * 50))

                    # Backward pass: earliest keyframe -> 0 (if earliest keyframe > 0)
                    if min_keyframe > 0:
                        for out_idx, obj_ids, logits in self.predictor.propagate_in_video(
                            state, start_frame_idx=min_keyframe, reverse=True
                        ):
                            if cancel_check and cancel_check():
                                self.predictor.reset_state(state)
                                raise JobCancelledException("Job was cancelled during backward propagation.")
                            mask_union = (logits > 0.0).any(dim=0).squeeze()
                            process_and_save_frame(out_idx, mask_union)
                            saved_count += 1
                            if progress_cb:
                                progress_cb("sam2_backward", 50 + int((saved_count / total_frames) * 50))

                    self.predictor.reset_state(state)
                    del state
                    release_system_memory()
            except JobCancelledException:
                if 'state' in locals() and self.predictor is not None:
                    try:
                        self.predictor.reset_state(state)
                        del state
                    except Exception:
                        pass
                release_system_memory()
                raise
            except Exception as e:
                if 'state' in locals() and self.predictor is not None:
                    try:
                        self.predictor.reset_state(state)
                        del state
                    except Exception:
                        pass
                release_system_memory()
                err_str = str(e).lower()
                is_oom = "out of memory" in err_str or (
                    TORCH_AVAILABLE and isinstance(e, getattr(torch.cuda, "OutOfMemoryError", ()))
                )
                if self.variant == "large" and self._try_fallback_to_small(f"propagation failed with {e}"):
                    # Retry full video propagation with small model
                    return self.propagate_full_video(
                        frames_dir=frames_dir,
                        output_mask_dir=output_mask_dir,
                        annotated_frame_idx=annotated_frame_idx,
                        box=box,
                        points=points,
                        labels=labels,
                        keyframe_prompts=keyframe_prompts,
                        dilation_px=dilation_px,
                        accumulate=accumulate,
                        progress_cb=progress_cb,
                        cancel_check=cancel_check,
                        existing_mask_dir=existing_mask_dir
                    )
                raise
        else:
            # Deterministic geometric approximation fallback for testing and environments
            # without model checkpoints or GPU.
            # NOTE: This fallback produces synthetic ellipse/circle masks translating across frames,
            # intended solely as a deterministic geometric approximation for testing, CI/CD, and
            # environments without weights, NOT neural SAM 2 tracking.
            first_img = cv2.imread(os.path.join(frames_dir, frame_files[0]))
            if first_img is None:
                raise RuntimeError(f"Could not read frame {frame_files[0]}")
            shape = first_img.shape

            # Group objects across keyframes by object id for temporal interpolation / nearest keyframe lookup
            obj_keyframes = {}
            for kp in keyframe_prompts:
                f_idx = kp["frame_idx"]
                for (obj_id, b, pts, lbls) in kp["objects"]:
                    if obj_id not in obj_keyframes:
                        obj_keyframes[obj_id] = []
                    obj_keyframes[obj_id].append((f_idx, b, pts, lbls))

            def generate_fallback_frame_mask(idx: int) -> np.ndarray:
                combined_mask = np.zeros(shape[:2], dtype=bool)
                for obj_id, kf_list in obj_keyframes.items():
                    # Find the nearest keyframe prompt for this object
                    best_f_idx, b, pts, lbls = min(kf_list, key=lambda item: abs(item[0] - idx))
                    offset = idx - best_f_idx
                    obj_mask = self._fallback_generate_mask(shape, b, pts, lbls, frame_offset=offset)
                    combined_mask = np.logical_or(combined_mask, obj_mask)
                return combined_mask

            for idx in range(min_keyframe, total_frames):
                if cancel_check and cancel_check():
                    raise JobCancelledException("Job was cancelled during fallback forward propagation.")
                segments[idx] = generate_fallback_frame_mask(idx)
                if progress_cb:
                    pct = int(((idx - min_keyframe + 1) / total_frames) * 50)
                    progress_cb("sam2_forward", pct)

            if min_keyframe > 0:
                for idx in range(min_keyframe - 1, -1, -1):
                    if cancel_check and cancel_check():
                        raise JobCancelledException("Job was cancelled during fallback backward propagation.")
                    segments[idx] = generate_fallback_frame_mask(idx)
                    if progress_cb:
                        pct = 50 + int(((min_keyframe - idx) / total_frames) * 50)
                        progress_cb("sam2_backward", pct)

        if cancel_check and cancel_check():
            raise JobCancelledException("Job was cancelled before saving masks.")

        # If fallback path was taken, save fallback segments to disk
        if segments:
            for idx in sorted(segments.keys()):
                dilated = self.dilate_mask(segments[idx], dilation_px)
                out_file = os.path.join(output_mask_dir, f"{idx:05d}.png")
                if accumulate:
                    read_dir = existing_mask_dir if existing_mask_dir is not None else output_mask_dir
                    source_file = os.path.join(read_dir, f"{idx:05d}.png")
                    if os.path.exists(source_file):
                        existing_mask = cv2.imread(source_file, cv2.IMREAD_GRAYSCALE)
                        if existing_mask is not None and existing_mask.shape == dilated.shape:
                            dilated = cv2.bitwise_or(existing_mask, dilated)
                cv2.imwrite(out_file, dilated)

            segments.clear()
            del segments
            release_system_memory()

        return output_mask_dir
