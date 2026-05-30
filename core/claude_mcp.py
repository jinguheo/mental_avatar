"""dashboard MCP의 claude.chat을 통해 Claude.ai 구독 재활용"""
import json
import pathlib
import urllib.request
import urllib.error

MCP_URL = "http://127.0.0.1:8765/mcp"
_SESSION_CACHE = pathlib.Path(__file__).parent.parent.parent / "my-dashboard" / ".claude_session_key"
_req_id = 0


def _next_id():
    global _req_id
    _req_id += 1
    return _req_id


def _load_session_key() -> str:
    try:
        if _SESSION_CACHE.exists():
            return _SESSION_CACHE.read_text(encoding="utf-8").strip()
    except Exception:
        pass
    return ""


def chat(messages: list[dict], system: str = "", session_key: str = "") -> str:
    """dashboard MCP claude.chat 호출. 실패 시 빈 문자열 반환."""
    if not session_key:
        session_key = _load_session_key()

    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": _next_id(),
        "method": "tools/call",
        "params": {
            "name": "claude.chat",
            "arguments": {
                "session_key": session_key,
                "messages": messages,
                "system": system
            }
        }
    }).encode()

    req = urllib.request.Request(
        MCP_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read())
        if "error" in body:
            raise RuntimeError(body["error"].get("message", "MCP error"))
        content = body["result"]["content"]
        return content[0]["json"]["text"]
    except Exception as e:
        raise RuntimeError(f"claude_mcp.chat 실패: {e}")


def is_available() -> bool:
    """dashboard MCP가 살아있는지 빠르게 확인"""
    try:
        req = urllib.request.Request(
            MCP_URL,
            data=json.dumps({"jsonrpc": "2.0", "id": 0, "method": "tools/list", "params": {}}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            body = json.loads(resp.read())
        return "result" in body
    except Exception:
        return False
