"""TimesFM 2.5 as a forecaster for protocol.walk_forward. Optional: never imported by CI or by the tests
except the guard tests, which do not load weights.

Pinned (G3 spec §7). API as documented in the README of the ``timesfm`` 2.0.2 package on PyPI
(uploaded 2026-07-02; read 2026-11-24). The 3.x packages describe 2.5 as an archived version and ship
TimesFM 3.0 code under a separate module; TimesFM 3.0 weights carry a non-commercial licence and are
refused here (spec §1).
"""
from __future__ import annotations

import numpy as np

REPO_ID = "google/timesfm-2.5-200m-pytorch"   # Apache-2.0 weights
REVISION = "1d95242"                            # model-card revision seen at G0 (2025-10-02); pin the full hash at first run
PACKAGE_PIN = "timesfm[torch]==2.0.2"
FORBIDDEN = ("timesfm-3", "timesfm3")           # TimesFM 3.0: non-commercial, non-production; never in this record


def check_repo_id(repo_id: str) -> str:
    """Refuse any TimesFM 3 checkpoint, whatever its spelling."""
    low = repo_id.lower().replace("_", "-")
    if any(f in low for f in FORBIDDEN):
        raise ValueError("TimesFM 3.0 is licensed non-commercial and non-production; it is not used for the published record (G3 spec §1).")
    if repo_id != REPO_ID:
        raise ValueError(f"only {REPO_ID} is pinned for the published record")
    return repo_id


def forecast_config_kwargs(max_context: int) -> dict:
    """ForecastConfig for monthly excess returns. infer_is_positive is OFF: returns can be negative."""
    return dict(max_context=max_context, max_horizon=16, normalize_inputs=True, use_continuous_quantile_head=True,
                force_flip_invariance=True, infer_is_positive=False, fix_quantile_crossing=True)


def make_forecaster(max_context: int = 1024, repo_id: str = REPO_ID, revision: str = REVISION):
    """Load TimesFM 2.5 on CPU in float32 with deterministic algorithms, and return a protocol forecaster."""
    check_repo_id(repo_id)
    import torch  # noqa: PLC0415  (optional dependency)
    import timesfm  # noqa: PLC0415

    torch.use_deterministic_algorithms(True)
    torch.set_num_threads(1)
    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(repo_id, revision=revision)
    model.compile(timesfm.ForecastConfig(**forecast_config_kwargs(max_context)))

    def forecaster(context, history, horizon):
        point, quant = model.forecast(horizon=horizon, inputs=[np.asarray(context, dtype=np.float32)])
        q = np.asarray(quant)[0]  # (horizon, 10): mean, then the 10th ... 90th percentiles
        return {"mean": np.asarray(point)[0], "q10": q[:, 1], "q30": q[:, 3], "q50": q[:, 5], "q90": q[:, 9]}

    return forecaster
