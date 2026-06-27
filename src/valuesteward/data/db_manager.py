"""Professional SQLite manager for Value Steward with WAL mode and transaction safety."""

import json
import sqlite3
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

DB_PATH = Path("data/steward.db")
SCHEMA_PATH = Path("data/schema.sql")

class DatabaseManager:
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self._init_db()

    def _get_connection(self):
        """Returns a connection with WAL mode enabled for concurrent performance."""
        conn = sqlite3.connect(self.db_path, timeout=10) # Wait up to 10s if locked
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _init_db(self):
        """Initialize the database with the schema if it doesn't exist."""
        if not self.db_path.exists():
            logger.info(f"Initializing fresh database at {self.db_path}")
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            with self._get_connection() as conn:
                with open(SCHEMA_PATH, "r") as f:
                    conn.executescript(f.read())

    def sync_intent(
        self, intent_dict: Dict[str, Any], conn: Optional[sqlite3.Connection] = None
    ):
        """Upsert a single intent into the database."""
        world_id = intent_dict.get("world_context_generated_at")
        
        sql = """
            INSERT OR REPLACE INTO intents (
                id, timestamp, mode, action_type, symbol, size_pct, 
                expected_price, reason_code, explanation, 
                pre_risk_exposure_pct, post_risk_exposure_pct, world_context_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
        vals = (
            intent_dict.get("id"),
            intent_dict.get("timestamp"),
            intent_dict.get("mode"),
            intent_dict.get("action_type"),
            intent_dict.get("symbol"),
            intent_dict.get("size_pct"),
            intent_dict.get("expected_price"),
            intent_dict.get("reason_code"),
            intent_dict.get("explanation"),
            intent_dict.get("pre_risk_exposure_pct"),
            intent_dict.get("post_risk_exposure_pct"),
            world_id
        )

        if conn:
            conn.execute(sql, vals)
        else:
            with self._get_connection() as c:
                c.execute(sql, vals)

    def sync_world_context(
        self, context_dict: Dict[str, Any], conn: Optional[sqlite3.Connection] = None
    ):
        """Upsert a world context entry."""
        ctx_id = context_dict.get("generated_at")
        if not ctx_id:
            return

        sql = """
            INSERT OR REPLACE INTO world_context (
                id, date, slot, generated_at, macro_score, 
                macro_label, scout_score, scout_label, scout_thesis, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
        vals = (
            ctx_id,
            context_dict.get("date"),
            context_dict.get("slot"),
            context_dict.get("generated_at"),
            context_dict.get("macro_view", {}).get("macro_score"),
            context_dict.get("macro_view", {}).get("macro_label"),
            context_dict.get("scout_score"),
            context_dict.get("scout_label"),
            context_dict.get("scout_thesis"),
            json.dumps(context_dict)
        )

        if conn:
            conn.execute(sql, vals)
        else:
            with self._get_connection() as c:
                c.execute(sql, vals)

    def sync_signals(self, signals: List[Any], world_context_id: Optional[str] = None):
        """Upsert current signal ranking into the database."""
        sql = """
            INSERT INTO signals (
                symbol, momentum_rank, vol_rank, drawdown_rank, 
                score, volatility, last_close, world_context_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """
        with self._get_connection() as conn:
            for sig in signals:
                conn.execute(sql, (
                    sig.symbol, sig.momentum_rank, sig.vol_rank, sig.drawdown_rank,
                    sig.score, sig.volatility, sig.last_close, world_context_id
                ))

def sync_all_logs():
    """Batch sync all JSONL logs to SQLite using a single transaction."""
    mgr = DatabaseManager()
    
    with mgr._get_connection() as conn:
        # 1. Sync World Contexts
        context_file = Path("data/world-context.jsonl")
        if context_file.exists():
            logger.info("Syncing World Contexts...")
            with open(context_file, "r") as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        mgr.sync_world_context(json.loads(line), conn=conn)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("Failed to sync world-context row: %s", exc)
        # 2. Sync Intents
        intent_file = Path("logs/intent_log.jsonl")
        if intent_file.exists():
            logger.info("Syncing Intent Logs...")
            with open(intent_file, "r") as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        mgr.sync_intent(json.loads(line), conn=conn)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("Failed to sync intent row: %s", exc)
    
    logger.info("Database sync complete.")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    sync_all_logs()
