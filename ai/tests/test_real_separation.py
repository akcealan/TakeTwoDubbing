from __future__ import annotations

import os

import numpy as np
import pytest

from take_two_ai.config import Settings, configure_private_caches
from take_two_ai.separation import BANDIT_MODEL


@pytest.mark.skipif(
    os.getenv("TAKETWO_REAL_SEPARATION") != "1",
    reason="opt-in real Bandit v2 checkpoint test",
)
def test_real_bandit_v2_multi_cached_checkpoint() -> None:
    from bandit_infer import BanditSession

    settings = Settings()
    configure_private_caches(settings, offline=True)
    device = os.getenv("TAKETWO_SEPARATION_TEST_DEVICE", "cpu")
    session = BanditSession(
        BANDIT_MODEL, device=device, weights_dir=settings.separation_model_cache
    )
    info = session.cache_info()
    assert info["verified"] is True
    session.load()
    try:
        seconds = float(os.getenv("TAKETWO_SEPARATION_TEST_SECONDS", "1"))
        samples = np.zeros((2, round(48_000 * seconds)), dtype=np.float32)
        output = session.infer(samples, sample_rate=48_000)
    finally:
        session.close()
    assert set(output) == {"speech", "music", "effects"}
    assert all(stem.shape == samples.shape for stem in output.values())
    assert all(np.isfinite(stem).all() for stem in output.values())
