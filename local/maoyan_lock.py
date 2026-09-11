#!/usr/bin/env python3
"""Log in to Maoyan with Chromium once, then lock unpaid seats over HTTP."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


ROOT = Path(__file__).resolve().parent
SESSION_PATH = ROOT / ".maoyan-lock-session.json"
PROFILE_PATH = ROOT / ".maoyan-lock-profile"
MAOYAN_ORIGIN = "https://www.maoyan.com"
LOGIN_URL = (
    "https://passport.maoyan.com/pc/login?pagesource=maoyan"
    "&redirectURL=https%3A%2F%2Fwww.maoyan.com%2F"
)
DEFAULT_CREATE_ORDER_QUERY = {
    "yodaReady": "h5",
    "csecplatform": "4",
    "csecversion": "2.6.0",
}
DEFAULT_TIMEOUT_SECONDS = 15


class MaoyanError(RuntimeError):
    """A user-safe error that never includes session credentials."""


@dataclass
class SessionState:
    cookies: List[Dict[str, object]]
    csrf: str
    mtgsig: str
    create_order_query: Dict[str, str]
    user_agent: str
    saved_at: str

    @classmethod
    def from_dict(cls, raw: Dict[str, object]) -> "SessionState":
        state = cls(
            cookies=list(raw.get("cookies") or []),
            csrf=str(raw.get("csrf") or ""),
            mtgsig=str(raw.get("mtgsig") or ""),
            create_order_query={
                str(key): str(value)
                for key, value in dict(raw.get("create_order_query") or {}).items()
                if key in DEFAULT_CREATE_ORDER_QUERY and value
            },
            user_agent=str(raw.get("user_agent") or ""),
            saved_at=str(raw.get("saved_at") or ""),
        )
        if not state.cookies or not state.mtgsig:
            raise MaoyanError("本地登录会话不完整，请重新执行 login")
        return state


def save_session(state: SessionState, path: Path = SESSION_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(state), ensure_ascii=False), encoding="utf-8")
    os.chmod(path, 0o600)


def load_session(path: Path = SESSION_PATH) -> SessionState:
    if not path.is_file():
        raise MaoyanError("未找到本地登录会话，请先执行 login")
    try:
        return SessionState.from_dict(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError) as exc:
        raise MaoyanError("本地登录会话无效，请重新执行 login") from exc


def cookie_header(cookies: Sequence[Dict[str, object]]) -> str:
    pairs = []
    for cookie in cookies:
        name = str(cookie.get("name") or "").strip()
        value = str(cookie.get("value") or "")
        if name:
            pairs.append(f"{name}={value}")
    return "; ".join(pairs)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


class MaoyanClient:
    def __init__(self, state: SessionState):
        self.state = state
        self.opener = build_opener(NoRedirect())

    def _headers(self, referer: str, include_signature: bool = False) -> Dict[str, str]:
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Cookie": cookie_header(self.state.cookies),
            "Referer": referer,
            "User-Agent": self.state.user_agent,
            "X-Requested-With": "XMLHttpRequest",
        }
        if include_signature:
            headers["mtgsig"] = self.state.mtgsig
            headers["Origin"] = MAOYAN_ORIGIN
        return headers

    def request(self, url: str, *, method: str = "GET", data: Optional[bytes] = None,
                referer: str = MAOYAN_ORIGIN + "/", signed: bool = False) -> Tuple[int, str]:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != "www.maoyan.com":
            raise MaoyanError("拒绝请求非猫眼 HTTPS 地址")
        headers = self._headers(referer, include_signature=signed)
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
        request = Request(url, data=data, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=DEFAULT_TIMEOUT_SECONDS) as response:
                body = response.read().decode(response.headers.get_content_charset() or "utf-8", "replace")
                if response.status != 200:
                    raise MaoyanError(f"猫眼请求失败（HTTP {response.status}），请重新登录后重试")
                return response.status, body
        except HTTPError as exc:
            raise MaoyanError(f"猫眼请求失败（HTTP {exc.code}），请重新登录后重试") from exc
        except URLError as exc:
            raise MaoyanError("无法连接猫眼，请检查网络后重试") from exc

    def get_text(self, url: str, referer: str = MAOYAN_ORIGIN + "/") -> str:
        return self.request(url, referer=referer)[1]


def maoyan_chrome_path() -> Optional[str]:
    candidate = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    return str(candidate) if candidate.is_file() else None


def login(args: argparse.Namespace) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise MaoyanError("未安装 Python Playwright，无法启动 Chromium 登录") from exc

    captured: Dict[str, object] = {"create_order_query": {}}
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_PATH),
            executable_path=maoyan_chrome_path(),
            headless=False,
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()

            def capture_request(request) -> None:
                if not request.url.startswith(MAOYAN_ORIGIN):
                    return
                signature = request.headers.get("mtgsig", "")
                if signature:
                    captured["mtgsig"] = signature
                    query = parse_qs(urlparse(request.url).query)
                    actual = captured["create_order_query"]
                    if isinstance(actual, dict):
                        for key in DEFAULT_CREATE_ORDER_QUERY:
                            if query.get(key):
                                actual[key] = query[key][0]

            context.on("request", capture_request)
            page.goto(LOGIN_URL, wait_until="domcontentloaded")
            input("请在打开的 Chromium 中完成猫眼登录，完成后回到这里按 Enter：")
            page.goto(
                f"{MAOYAN_ORIGIN}/cinema/{args.cinema_id}",
                wait_until="domcontentloaded",
            )
            page.evaluate(
                """async (cinemaId) => {
                  await fetch(`/ajax/cinemaDetail?cinemaId=${encodeURIComponent(cinemaId)}`, {
                    credentials: 'include',
                  });
                }""",
                str(args.cinema_id),
            )
            page.wait_for_timeout(1000)
            cookies = context.cookies(MAOYAN_ORIGIN)
            csrf = next((str(c["value"]) for c in cookies if c.get("name") == "_csrf"), "")
            user_agent = page.evaluate("navigator.userAgent")
        finally:
            context.close()

    signature = captured.get("mtgsig", "")
    if not cookies or not csrf or not signature:
        raise MaoyanError("未捕获完整登录态或 H5Guard 签名，请确认已完成登录后重试")
    save_session(
        SessionState(
            cookies=cookies,
            csrf=csrf,
            mtgsig=signature,
            create_order_query=dict(captured["create_order_query"]),
            user_agent=user_agent,
            saved_at=datetime.now(timezone.utc).isoformat(),
        )
    )
    print("登录态已保存。本地锁座命令不会再启动 Chromium。")


def find_show_url(html: str, cinema_id: str, movie_id: str, requested_seq_no: Optional[str]) -> str:
    links = re.findall(r'href="(/xseats/(\d+)\?[^\"]+)"', html)
    for link, seq_no in links:
        if requested_seq_no and seq_no != requested_seq_no:
            continue
        query = urlparse(link).query
        if f"movieId={movie_id}" not in query or f"cinemaId={cinema_id}" not in query:
            continue
        return urljoin(MAOYAN_ORIGIN, unescape(link))
    raise MaoyanError("没有找到指定影片的可选场次")


def parse_attributes(source: str) -> Dict[str, str]:
    return {key: unescape(value) for key, value in re.findall(r'data-([\w-]+)="([^\"]*)"', source)}


def parse_seat_page(html: str) -> Tuple[Dict[str, str], List[Dict[str, str]]]:
    block = re.search(r'<div class="seats-block"([\s\S]*?)>', html)
    if not block:
        raise MaoyanError("选座页缺少场次配置，请重新登录后重试")
    config = parse_attributes(block.group(1))
    required = ("section-id", "section-name", "seq-no")
    if any(not config.get(key) for key in required):
        raise MaoyanError("选座页场次配置不完整")
    seats = []
    for match in re.finditer(r'<span class="seat selectable"([\s\S]*?)></span>', html):
        attrs = parse_attributes(match.group(1))
        if attrs.get("column-id") and attrs.get("row-id") and attrs.get("no"):
            seats.append({
                "rowId": attrs["row-id"],
                "columnId": attrs["column-id"],
                "seatNo": attrs["no"],
                "type": attrs.get("st") or "N",
            })
    return config, seats


def choose_adjacent_seats(seats: Iterable[Dict[str, str]], count: int) -> List[Dict[str, str]]:
    if count != 2:
        raise MaoyanError("当前仅支持锁定 2 张相邻座位")
    rows: Dict[str, List[Dict[str, str]]] = {}
    for seat in seats:
        rows.setdefault(seat["rowId"], []).append(seat)
    pairs: List[List[Dict[str, str]]] = []
    for row in rows.values():
        row.sort(key=lambda seat: int(seat["columnId"]))
        for index in range(len(row) - 1):
            current, following = row[index], row[index + 1]
            if int(following["columnId"]) == int(current["columnId"]) + 1:
                pairs.append([current, following])
    if not pairs:
        raise MaoyanError("当前场次没有两个相邻的可选座位")

    def score(pair: List[Dict[str, str]]) -> float:
        centre = (int(pair[0]["columnId"]) + int(pair[1]["columnId"])) / 2
        return abs(int(pair[0]["rowId"]) - 6) + abs(centre - 18.5)

    return min(pairs, key=score)


def create_order_url(state: SessionState) -> str:
    query = {**DEFAULT_CREATE_ORDER_QUERY, **state.create_order_query}
    return MAOYAN_ORIGIN + "/ajax/createOrder?" + urlencode(query)


def create_order(client: MaoyanClient, config: Dict[str, str], seats: List[Dict[str, str]], referer: str) -> Dict[str, object]:
    form = urlencode({
        "sectionId": config["section-id"],
        "sectionName": config["section-name"],
        "seqNo": config["seq-no"],
        "seats": json.dumps({"count": len(seats), "list": seats}, separators=(",", ":")),
    }).encode("utf-8")
    _, text = client.request(create_order_url(client.state), method="POST", data=form, referer=referer, signed=True)
    try:
        response = json.loads(text)
        order = response["data"]["data"]
        if not order.get("id"):
            raise ValueError("missing order id")
        return order
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise MaoyanError("锁座未成功，猫眼拒绝了当前会话或签名；请重新执行 login") from exc


def lock(args: argparse.Namespace) -> None:
    state = load_session()
    client = MaoyanClient(state)
    cinema_url = f"{MAOYAN_ORIGIN}/cinema/{args.cinema_id}?movieId={args.movie_id}"
    show_url = find_show_url(
        client.get_text(cinema_url),
        str(args.cinema_id),
        str(args.movie_id),
        args.seq_no,
    )
    config, seats = parse_seat_page(client.get_text(show_url, cinema_url))
    pair = choose_adjacent_seats(seats, args.count)
    labels = "、".join(seat["seatNo"] for seat in pair)
    if args.dry_run:
        print(f"dry-run: seqNo={config['seq-no']} seats={labels}")
        return
    order = create_order(client, config, pair, show_url)
    details = order.get("order") if isinstance(order.get("order"), dict) else {}
    deadline = details.get("payLeftSecond") if isinstance(details, dict) else None
    suffix = f"，剩余支付秒数 {deadline}" if deadline is not None else ""
    print(f"锁座成功：{labels}{suffix}。未调用支付接口。")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    login_parser = commands.add_parser("login", help="仅启动 Chromium 完成登录并保存会话")
    login_parser.add_argument("--cinema-id", required=True, help="用于捕获签名的猫眼影院 ID")
    login_parser.set_defaults(handler=login)
    lock_parser = commands.add_parser("lock", help="纯 HTTP 锁定两个相邻座位")
    lock_parser.add_argument("--cinema-id", required=True)
    lock_parser.add_argument("--movie-id", required=True)
    lock_parser.add_argument("--seq-no")
    lock_parser.add_argument("--count", type=int, default=2)
    lock_parser.add_argument("--dry-run", action="store_true")
    lock_parser.set_defaults(handler=lock)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        args.handler(args)
        return 0
    except MaoyanError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
