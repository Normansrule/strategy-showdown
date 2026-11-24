"""Walk-forward evaluation of TimesFM 2.5 against simple baselines (G3 spec, docs/TIMESFM_SPEC.md; the spec named reference/timesfm/, renamed to avoid clashing with tests/python/reference.py).

Python only. The metrics, baselines and protocol run anywhere with numpy and scipy; the TimesFM
forecaster itself is optional (``timesfm_eval.model``) and is never loaded in CI.
"""
