"""World recognition for Value Steward."""

from typing import List, Optional, Dict, Any

from valuesteward.models import PortfolioSnapshot


def infer_world_tags(
    snapshot: PortfolioSnapshot, world_context: Optional[Dict[str, Any]] = None
) -> List[str]:
    """Infer high-level market regime tags from the snapshot and world context.

    Tags are designed to be stable, discrete strings suitable for pattern
    matching.  They fall into four groups:

    1. Macro view  — composite risk label and bucketed score.
    2. Signal tags — one tag per JS pipeline signal that crosses a threshold.
    3. Session slot — timing of the observation (pre_open / midday / pre_close).
    4. Portfolio state — current exposure bucket and position count.
    """

    tags: List[str] = ["DEFAULT"]
    ctx = world_context if isinstance(world_context, dict) else {}

    # ------------------------------------------------------------------
    # 1. Macro view
    # ------------------------------------------------------------------
    macro_view = ctx.get("macro_view")
    if isinstance(macro_view, dict):
        label_raw = macro_view.get("macro_label", "")
        label = str(label_raw).strip().upper().replace("-", "_")
        if label and label not in ("", "N/A", "NONE"):
            tags.append(f"MACRO_{label}")

        score = macro_view.get("macro_score")
        if isinstance(score, (int, float)):
            if score >= 0.6:
                tags.append("MACRO_SCORE_HIGH")
            elif score >= 0.3:
                tags.append("MACRO_SCORE_MEDIUM")
            else:
                tags.append("MACRO_SCORE_LOW")

        confidence = macro_view.get("confidence")
        if isinstance(confidence, (int, float)) and confidence < 0.5:
            tags.append("MACRO_DATA_SPARSE")

        # Mirrors the risk-off logic in decision_engine._risk_off_status so that
        # pattern matching can key on this without re-reading the macro label.
        risk_off_labels = {"stressed", "crisis-prone"}
        if str(label_raw).strip().lower() in risk_off_labels:
            tags.append("RISK_OFF_ACTIVE")

    # ------------------------------------------------------------------
    # 2. Individual signal tags (from JS rule-based pipeline)
    # ------------------------------------------------------------------
    raw_tags = ctx.get("tags")
    if isinstance(raw_tags, dict):
        rate_hawk = raw_tags.get("rate_hawkishness")
        if isinstance(rate_hawk, (int, float)):
            if rate_hawk >= 0.6:
                tags.append("RATE_HAWK")
            elif rate_hawk <= 0.4:
                tags.append("RATE_DOVE")
            else:
                tags.append("RATE_NEUTRAL")

        geo = raw_tags.get("geopolitical_tension")
        if isinstance(geo, (int, float)) and geo >= 0.5:
            tags.append("GEO_HIGH")

        energy = raw_tags.get("energy_shock_risk")
        if isinstance(energy, (int, float)) and energy >= 0.5:
            tags.append("ENERGY_RISK")

        recession = raw_tags.get("recession_fear")
        if isinstance(recession, (int, float)):
            if recession >= 0.5:
                tags.append("RECESSION_FEAR_HIGH")
            elif recession >= 0.3:
                tags.append("RECESSION_FEAR_ELEVATED")

        macro_risk = raw_tags.get("macro_risk")
        if isinstance(macro_risk, (int, float)) and macro_risk >= 0.5:
            tags.append("MACRO_RISK_HIGH")

    # ------------------------------------------------------------------
    # 3. Session slot
    # ------------------------------------------------------------------
    slot = ctx.get("slot")
    if slot and isinstance(slot, str):
        tags.append(f"SLOT_{slot.strip().upper()}")

    # ------------------------------------------------------------------
    # 4. Portfolio state
    # ------------------------------------------------------------------
    exposure = getattr(snapshot, "risk_exposure_pct", None)
    if isinstance(exposure, (int, float)):
        if exposure <= 0:
            tags.append("EXPOSURE_NONE")
        elif exposure < 0.2:
            tags.append("EXPOSURE_LOW")
        elif exposure < 0.4:
            tags.append("EXPOSURE_MEDIUM")
        else:
            tags.append("EXPOSURE_HIGH")

    positions = getattr(snapshot, "positions", None)
    if positions is not None:
        if len(positions) == 0:
            tags.append("POSITIONS_NONE")
        elif len(positions) > 1:
            tags.append("POSITIONS_MULTI")

    return tags
