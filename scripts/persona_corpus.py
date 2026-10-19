"""인물 시험용 자료 수집기 — 공개 출처에서 본인의 1인칭 글·발언과 배경 자료를 모아 로컬에 저장한다.

저장 위치: data/persona_corpus/<인물>/  (저장소에는 올리지 않는다 — .gitignore)
  texts/<id>.txt        정리한 본문
  manifest.jsonl        문서마다 출처 URL, 종류, 글자 수, 수집 시각

종류(kind):
  primary    본인이 직접 쓴 글·연설·편지 (특정 정보의 핵심)
  interview  인터뷰·질의응답 녹취 (질문과 실제 답 — 시험 문제의 원천)
  quotes     출처가 붙은 발언 모음(위키인용). 'Misattributed/Disputed' 구역은 제외한다
  lecture    강의·강연 (사고방식과 말투)
  bio        전기·백과 (일반 정보 층)

사용: python scripts/persona_corpus.py run [인물...]     (인물 생략하면 전부)
      python scripts/persona_corpus.py extra <인물> <종류> <제목> <URL>   (URL 하나 추가)
"""
import concurrent.futures as cf
import hashlib
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests
from lxml import html as lh

ROOT = Path(__file__).resolve().parent.parent / "data" / "persona_corpus"
UA = {"User-Agent": "mental-avatar-research/0.1 (private local research)"}
SESSION = requests.Session()
SESSION.headers.update(UA)


class _Resp:
    def __init__(self, status, content, headers):
        self.status_code, self.content, self.headers = status, content, headers

    @property
    def text(self):
        return self.content.decode("utf-8", errors="ignore")

    def json(self):
        return json.loads(self.content.decode("utf-8", errors="ignore"))


# brotli를 푸는 curl이 필요하다(윈도 기본 curl은 못 푼다). Git 번들 curl이 있으면 그것을 쓴다.
CURL = next((c for c in ("C:/Program Files/Git/mingw64/bin/curl.exe", "curl") if c == "curl" or Path(c).exists()), "curl")
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def get(url: str, retries: int = 3, params: dict | None = None, browser: bool = False, **kw):
    """curl로 받는다 — 일부 사이트(버크셔 등)가 brotli로만 응답해 requests가 못 푸는 문제를 피한다."""
    import subprocess
    import tempfile
    from urllib.parse import urlencode
    if params:
        url += ("&" if "?" in url else "?") + urlencode(params)
    last = None
    if "wikimedia" not in url and not re.search(r"\.wiki(pedia|quote|source)\.org", url):
        browser = True   # 위키 API 외에는 브라우저 UA로 받는다(알 수 없는 UA를 늘어뜨리는 사이트가 있다)
    for i in range(retries):
        with tempfile.TemporaryDirectory() as tmp:
            body, head = Path(tmp) / "b", Path(tmp) / "h"
            cmd = [CURL, "-s", "-L", "--compressed", "-m", "45", "-A", BROWSER_UA if browser else UA["User-Agent"], "-D", str(head), "-o", str(body), url]
            try:
                subprocess.run(cmd, check=True, timeout=120)
            except Exception as exc:  # noqa: BLE001
                last = str(exc)
                time.sleep(2 * (i + 1))
                continue
            raw_head = head.read_text(encoding="latin-1", errors="ignore").replace("\r\n", "\n")
            blocks = [b for b in raw_head.split("\n\n") if b.strip().startswith("HTTP")]
            block = blocks[-1] if blocks else ""
            m = re.match(r"HTTP/[\d.]+ (\d+)", block)
            code = int(m.group(1)) if m else 0
            headers = {k.lower(): v.strip() for k, _, v in (ln.partition(":") for ln in block.splitlines()[1:])}
            if code == 200:
                return _Resp(200, body.read_bytes(), headers)
            last = "HTTP %s" % code
            if code in (403, 404, 410) and (browser or code != 403):
                break
            if code == 403 and not browser:
                browser = True   # 한 번은 브라우저 UA로 다시 시도
                continue
        time.sleep(2 * (i + 1))
    raise RuntimeError("%s: %s" % (url, last))


def html_to_text(raw: bytes, encoding: str | None = None) -> str:
    doc = lh.fromstring(raw.decode(encoding or "utf-8", errors="ignore") if encoding else raw)
    for bad in doc.xpath("//script|//style|//nav|//header|//footer|//noscript|//form|//aside"):
        bad.getparent().remove(bad)
    for br in doc.xpath("//br"):
        br.tail = "\n" + (br.tail or "")
    for block in doc.xpath("//p|//div|//li|//h1|//h2|//h3|//h4|//tr|//blockquote"):
        block.tail = "\n" + (block.tail or "")
    text = doc.text_content()
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()


def pdf_to_text(raw: bytes) -> str:
    import fitz
    with fitz.open(stream=raw, filetype="pdf") as pdf:
        return "\n".join(page.get_text() for page in pdf).strip()


def fetch_text(url: str) -> str:
    r = get(url)
    ctype = r.headers.get("content-type", "").lower()
    if "pdf" in ctype or url.lower().endswith(".pdf"):
        return pdf_to_text(r.content)
    # 인코딩: 헤더가 없으면 일단 바이트를 lxml에 맡긴다
    return html_to_text(r.content)


def wiki_text(site: str, title: str) -> str:
    """MediaWiki 본문(일반 텍스트). site: en.wikipedia.org / en.wikiquote.org / en.wikisource.org"""
    if "wikisource" in site:
        r = get("https://%s/w/api.php" % site, params={"action": "parse", "page": title, "prop": "text", "format": "json", "redirects": 1, "disablelimitreport": 1})
        # encoding을 지정하지 않으면 lxml이 바이트를 latin-1로 읽어 한국어·한문이 깨진다(ko.wikisource에서 확인).
        return html_to_text(r.json()["parse"]["text"]["*"].encode("utf-8"), "utf-8")
    r = get("https://%s/w/api.php" % site, params={
        "action": "query", "prop": "extracts", "explaintext": 1, "exsectionformat": "wiki",
        "titles": title, "format": "json", "redirects": 1})
    pages = r.json()["query"]["pages"]
    page = next(iter(pages.values()))
    return (page.get("extract") or "").strip()


def wiki_search(site: str, query: str, limit: int = 10) -> list[str]:
    r = get("https://%s/w/api.php" % site, params={"action": "query", "list": "search", "srsearch": query, "srlimit": limit, "format": "json"})
    return [h["title"] for h in r.json()["query"]["search"]]


def drop_disputed(text: str) -> str:
    """위키인용에서 출처가 의심스러운 구역(Misattributed/Disputed/Quotes about)을 뺀다 — 가짜 명언 방지."""
    parts = re.split(r"\n(?==+ [^=\n]+ =+\n)", text)
    keep = []
    for part in parts:
        head = part.split("\n", 1)[0].lower()
        if re.search(r"misattributed|disputed|quotes about|external links|see also|sources", head):
            continue
        keep.append(part)
    return "\n".join(keep)


def slug(s: str) -> str:
    return re.sub(r"[^\w]+", "_", s, flags=re.UNICODE).strip("_")[:60] or hashlib.sha1(s.encode()).hexdigest()[:8]


# ── 출처 목록 ─────────────────────────────────────────────
# (kind, title, loader) — loader는 ('wiki', site, title) | ('url', url) | ('wikiquote', title)
def berkshire_letters() -> list:
    r = get("https://www.berkshirehathaway.com/letters/letters.html")
    doc = lh.fromstring(r.content)
    out = []
    for href in doc.xpath("//a/@href"):
        if re.search(r"(\d{4}).*\.(html|pdf)$", href, re.I) and "letters" in (href if href.startswith("http") else "/letters/" + href):
            url = href if href.startswith("http") else "https://www.berkshirehathaway.com/letters/" + href.lstrip("/").replace("letters/", "")
            year = re.search(r"(19|20)\d{2}", href).group(0)
            out.append(("primary", "Berkshire Hathaway chairman's letter %s" % year, ("url", url)))
    seen, uniq = set(), []
    for item in out:
        if item[2][1] not in seen:
            seen.add(item[2][1])
            uniq.append(item)
    return uniq


def buffett_meetings() -> list:
    """CNBC Warren Buffett Archive: 연도별 주주총회 오전·오후 전체 세션(질의응답 녹취 전문이 페이지에 들어 있다)."""
    out = []
    idx = get("https://buffett.cnbc.com/annual-meetings/")
    years = sorted(set(re.findall(r"https://buffett\.cnbc\.com/(\d{4})-berkshire-hathaway-annual-meeting/", idx.text)))
    for year in years:
        try:
            page = get("https://buffett.cnbc.com/%s-berkshire-hathaway-annual-meeting/" % year)
        except RuntimeError:
            continue
        for href in sorted(set(re.findall(r"https://buffett\.cnbc\.com/video/[^\"\s<>]+?(?:morning|afternoon)-session[^\"\s<>]*?\.html", page.text))):
            part = "morning" if "morning" in href else "afternoon"
            out.append(("interview", "Berkshire annual meeting %s %s session (Q&A)" % (year, part), ("url", href)))
    return out


def feynman_lectures() -> list:
    out = []
    for vol, n in (("I", 52), ("II", 42), ("III", 21)):
        for i in range(1, n + 1):
            out.append(("lecture", "Feynman Lectures on Physics vol %s ch %02d" % (vol, i), ("url", "https://www.feynmanlectures.caltech.edu/%s_%02d.html" % (vol, i))))
    return out


SOURCES = {
    "buffett": lambda: [
        ("bio", "Wikipedia: Warren Buffett", ("wiki", "en.wikipedia.org", "Warren Buffett")),
        ("bio", "Wikipedia: Berkshire Hathaway", ("wiki", "en.wikipedia.org", "Berkshire Hathaway")),
        ("bio", "Wikipedia: Benjamin Graham", ("wiki", "en.wikipedia.org", "Benjamin Graham")),
        ("quotes", "Wikiquote: Warren Buffett", ("wikiquote", "Warren Buffett")),
        ("primary", "Berkshire owner's manual", ("url", "https://www.berkshirehathaway.com/ownman.pdf")),
    ] + berkshire_letters() + buffett_meetings(),
    "feynman": lambda: [
        ("bio", "Wikipedia: Richard Feynman", ("wiki", "en.wikipedia.org", "Richard Feynman")),
        ("bio", "Wikipedia: Challenger disaster", ("wiki", "en.wikipedia.org", "Space Shuttle Challenger disaster")),
        ("quotes", "Wikiquote: Richard Feynman", ("wikiquote", "Richard Feynman")),
        ("primary", "Cargo Cult Science (1974 Caltech commencement)", ("url", "https://calteches.library.caltech.edu/51/2/CargoCult.htm")),
        ("primary", "Rogers Commission Appendix F: Personal observations on the reliability of the Shuttle", ("url", "https://history.nasa.gov/rogersrep/v2appf.htm")),
        ("primary", "The Value of Science (1955)", ("url", "https://calteches.library.caltech.edu/1575/1/Science.pdf")),
        ("interview", "The Pleasure of Finding Things Out - BBC Horizon 1981 transcript (excerpt PDF)", ("url", "https://learning.media.mit.edu/courses/mas713/readings/Finding_Things_Out.pdf")),
        ("interview", "Caltech Engineering & Science 1974 interview with Feynman", ("url", "https://calteches.library.caltech.edu/3012/")),
        ("lecture", "Feynman at 100 (Caltech magazine 2018)", ("url", "https://calteches.library.caltech.edu/4802/1/Feynman100.summer18.pdf")),
    ],   # 강의록(feynmanlectures.caltech.edu)은 봇 차단(403)이라 제외
    "einstein": lambda: [
        ("bio", "Wikipedia: Albert Einstein", ("wiki", "en.wikipedia.org", "Albert Einstein")),
        ("bio", "Wikipedia: Einstein–Szilard letter", ("wiki", "en.wikipedia.org", "Einstein–Szilard letter")),
        ("bio", "Wikipedia: Religious and philosophical views of Albert Einstein", ("wiki", "en.wikipedia.org", "Religious and philosophical views of Albert Einstein")),
        ("quotes", "Wikiquote: Albert Einstein", ("wikiquote", "Albert Einstein")),
        ("interview", "What Life Means to Einstein (Saturday Evening Post, 1929)", ("url", "https://www.saturdayeveningpost.com/wp-content/uploads/satevepost/what_life_means_to_einstein.pdf")),
        ("primary", "Letter to F. D. Roosevelt, Aug 2 1939", ("wiki", "en.wikisource.org", "Albert Einstein to Franklin D. Roosevelt - August 2, 1939")),
    ] + [("primary", "Letter to Stephen Brunauer %s" % d, ("wiki", "en.wikisource.org", "Albert Einstein to Stephen Brunauer - %s" % d)) for d in (
        "June 18, 1943", "June 29, 1943", "July 30, 1943", "August 13, 1943", "August 22, 1943", "May 17, 1943", "January 4, 1944", "October 15, 1944")] + [
    ],
    "jobs": lambda: [
        ("bio", "Wikipedia: Steve Jobs", ("wiki", "en.wikipedia.org", "Steve Jobs")),
        ("bio", "Wikipedia: Apple Inc.", ("wiki", "en.wikipedia.org", "Apple Inc.")),
        ("bio", "Wikipedia: NeXT", ("wiki", "en.wikipedia.org", "NeXT")),
        ("quotes", "Wikiquote: Steve Jobs", ("wikiquote", "Steve Jobs")),
        ("primary", "Stanford commencement 2005 (TED transcript)", ("url", "https://www.ted.com/talks/steve_jobs_how_to_live_before_you_die/transcript")),
        ("interview", "Steve Jobs 2001 Japanese TV interview transcript", ("url", "https://minifeed.net/items/lyadtKmIZQUF")),
        ("interview", "Steve Jobs at D8 2010 transcript", ("url", "https://www.ithinkdiff.com/steve-jobs-at-d8-videos-and-interview-transcript-9712/")),
        ("interview", "Steve Jobs interview 1995 (OHQ)", ("url", "https://ohq.org.au/steve-jobs-interview-1995/")),
    ],
    "songhae": lambda: [(k, t, ("url", u)) for k, t, u in [
        ("interview", "강일홍의 스페셜인터뷰㉔-송해 (더팩트)", "https://news.tf.co.kr/read/ogmeta/1745131.htm"),
        ("interview", "송해, '딴따라'가 자부심 되기까지 70년의 기억 (OSEN 2015)", "https://www.osen.co.kr/article/G1110140149"),
        ("interview", "한편의 영화같은 평전 '송해, 나는 딴따라다' (아주경제 2015)", "https://www.ajunews.com/view/20150430141923254"),
        ("interview", "[직격인터뷰] 100세까진 문제없다 하셨어요 입원 송해 (경향 2020)", "https://sports.khan.co.kr/article/202001090800003/amp"),
        ("interview", "나를 돌아봐 조영남 송해 선생님은 완성된 인격체 (텐아시아 2015)", "https://www.tenasia.co.kr/article/2015092599674"),
        ("interview", "나를 돌아봐 송해 (텐아시아 2015-2)", "https://www.tenasia.co.kr/article/2015092599534"),
        ("bio", "송해 한 시대를 대표한 국민 딴따라 (데일리안 칼럼)", "https://www.dailian.co.kr/news/view/1121359/"),
        ("bio", "[D:현장] 송해 1927 한 없이 눈물만 (데일리안)", "https://www.dailian.co.kr/news/view/1051084/"),
        ("bio", "95세 송해 기적처럼 공연 마쳐 (문화일보)", "https://www.munhwa.com/article/11282586"),
        ("bio", "송해 95세 일기로 별세 (텐아시아 2022)", "https://www.tenasia.co.kr/article/2022060879644"),
        ("interview", "송해 인터뷰 (세계일보 2019)", "https://www.segye.com/newsView/20190515508823"),
        ("interview", "송해 기사 (아주경제 2021)", "https://www.ajunews.com/view/20211115182325618"),
        ("interview", "송해 기사 (노컷뉴스 5770473)", "https://nocutnews.co.kr/news/5770473"),
        ("interview", "송해 기사 (노컷뉴스 5769015)", "https://nocutnews.co.kr/news/5769015"),
        ("interview", "송해 기사 (전북일보 2011)", "https://jjan.kr/article/20110704402334"),
        ("interview", "송해 기사 (서울시 미디어허브)", "https://mediahub.seoul.go.kr/archives/2006590"),
    ]],
    # 세종대왕: 영상·녹음이 없고 본인이 직접 쓴 글도 훈민정음 서문 정도라서 전부 '기록에 적힌 것(bio)'으로 둔다.
    # 실록은 관찬 사서(제3자 기록)이므로 본인 발언으로 취급하지 않는다. 출처는 위키문헌·위키백과(공개).
    "sejong": lambda: [
        ("bio", "위키백과: 세종", ("wiki", "ko.wikipedia.org", "세종")),
        ("bio", "위키백과: 집현전", ("wiki", "ko.wikipedia.org", "집현전")),
        ("bio", "위키백과: 조선왕조실록", ("wiki", "ko.wikipedia.org", "조선왕조실록")),
        ("bio", "위키문헌: 훈민정음(해례본)", ("wiki", "ko.wikisource.org", "훈민정음")),
        ("bio", "위키문헌: 훈민정음언해", ("wiki", "ko.wikisource.org", "훈민정음언해")),
        ("bio", "위키문헌: 용비어천가", ("wiki", "ko.wikisource.org", "용비어천가")),
        ("bio", "위키문헌: 세종실록 25년(1443, 훈민정음 창제)", ("wiki", "ko.wikisource.org", "조선왕조실록/세종장헌대왕실록/25년")),
        ("bio", "위키문헌: 세종실록 28년(1446, 훈민정음 반포)", ("wiki", "ko.wikisource.org", "조선왕조실록/세종장헌대왕실록/28년")),
    ],
    # 역사 인물군: 본인 저작·발언이 남은 경우 primary, 그 외의 사실은 bio로 구분한다.
    # 역사 기록은 현대 인터뷰처럼 내면을 확정하지 못하므로 질문 은행의 미확인 영역은 그대로 비워 둔다.
    "yi_sun_sin": lambda: [
        ("bio", "위키백과: 이순신", ("wiki", "ko.wikipedia.org", "이순신")),
        ("bio", "위키백과: 난중일기", ("wiki", "ko.wikipedia.org", "난중일기")),
        ("primary", "위키문헌: 난중일기", ("wiki", "ko.wikisource.org", "난중일기")),
        ("quotes", "위키인용(한국어): 이순신", ("wiki", "ko.wikiquote.org", "이순신")),   # 영어판은 인용문 없이 전기 소개문뿐이라 한국어판 사용
    ],
    "leonardo": lambda: [
        ("bio", "Wikipedia: Leonardo da Vinci", ("wiki", "en.wikipedia.org", "Leonardo da Vinci")),
        ("bio", "Wikipedia: Leonardo's notebooks", ("wiki", "en.wikipedia.org", "Leonardo's notebooks")),
        ("quotes", "Wikiquote: Leonardo da Vinci", ("wikiquote", "Leonardo da Vinci")),
        # eBook 5000 is Leonardo's notebooks. The former 49910 URL was a Dutch work by Joost van den Vondel.
        ("primary", "Project Gutenberg: The Notebooks of Leonardo da Vinci - Complete (eBook 5000)", ("url", "https://www.gutenberg.org/cache/epub/5000/pg5000.html")),
    ],
    "marie_curie": lambda: [
        ("bio", "Wikipedia: Marie Curie", ("wiki", "en.wikipedia.org", "Marie Curie")),
        ("bio", "Wikipedia: Radioactivity", ("wiki", "en.wikipedia.org", "Radioactivity")),
        ("quotes", "Wikiquote: Marie Curie", ("wikiquote", "Marie Curie")),
        # The 1903 physics page says that Curie delivered no lecture; the actual lecture is Chemistry 1911.
        ("lecture", "Nobel Prize: Marie Curie 1911 Nobel lecture - Radium and the New Concepts in Chemistry", ("url", "https://www.nobelprize.org/prizes/chemistry/1911/marie-curie/lecture/?print=1")),
        # 본인 저술: 남편 피에르 퀴리 전기(1923). 말미에 마리 퀴리 본인의 자전적 회고가 포함된 공개 도메인 도서(eBook 69617).
        ("primary", "Project Gutenberg: Pierre Curie by Marie Curie (eBook 69617)", ("url", "https://www.gutenberg.org/ebooks/69617.txt.utf-8")),
    ],
    "marcus_aurelius": lambda: [
        ("bio", "Wikipedia: Marcus Aurelius", ("wiki", "en.wikipedia.org", "Marcus Aurelius")),
        ("bio", "Wikipedia: Meditations", ("wiki", "en.wikipedia.org", "Meditations")),
        ("quotes", "Wikiquote: Marcus Aurelius", ("wikiquote", "Marcus Aurelius")),
        ("primary", "Project Gutenberg: Meditations", ("url", "https://www.gutenberg.org/files/2680/2680-h/2680-h.htm")),
    ],
    "brucelee": lambda: [
        ("bio", "Wikipedia: Bruce Lee", ("wiki", "en.wikipedia.org", "Bruce Lee")),
        ("bio", "Wikipedia: Jeet Kune Do", ("wiki", "en.wikipedia.org", "Jeet Kune Do")),
        ("bio", "Wikipedia: Longstreet (TV series)", ("wiki", "en.wikipedia.org", "Longstreet (TV series)")),
        ("quotes", "Wikiquote: Bruce Lee", ("wikiquote", "Bruce Lee")),
        ("interview", "Pierre Berton Show 1971 interview transcript", ("url", "https://powerplace.org/blog/the-lost-interview-bruce-lee-on-philosophy-fame-and-being-like-water")),
    ],
}


def load(loader) -> str:
    kind = loader[0]
    if kind == "wiki":
        return wiki_text(loader[1], loader[2])
    if kind == "wikiquote":
        return drop_disputed(wiki_text("en.wikiquote.org", loader[1]))
    if kind == "url":
        return fetch_text(loader[1])
    raise ValueError(kind)


def save(person: str, kind: str, title: str, loader, text: str):
    d = ROOT / person
    (d / "texts").mkdir(parents=True, exist_ok=True)
    doc_id = "%s_%s" % (kind, slug(title))
    (d / "texts" / (doc_id + ".txt")).write_text(text, encoding="utf-8")
    src = loader[-1] if loader[0] != "wiki" else "https://%s/wiki/%s" % (loader[1], loader[2].replace(" ", "_"))
    if loader[0] == "wikiquote":
        src = "https://en.wikiquote.org/wiki/" + loader[1].replace(" ", "_")
    with open(d / "manifest.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"id": doc_id, "person": person, "kind": kind, "title": title, "source": src, "chars": len(text),
                             "fetched_at": datetime.now().isoformat(timespec="seconds")}, ensure_ascii=False) + "\n")


def done_ids(person: str) -> set[str]:
    m = ROOT / person / "manifest.jsonl"
    if not m.exists():
        return set()
    return {json.loads(l)["id"] for l in m.read_text(encoding="utf-8").splitlines() if l.strip()}


def run_person(person: str, items=None) -> dict:
    items = items if items is not None else SOURCES[person]()
    have = done_ids(person)
    stats = {"ok": 0, "skipped": 0, "failed": [], "chars": 0}

    def work(item):
        kind, title, loader = item
        if "%s_%s" % (kind, slug(title)) in have:
            return ("skip", title, 0)
        try:
            text = load(loader)
            if len(text) < 300:
                return ("fail", title, "본문이 너무 짧음(%d자)" % len(text))
            return ("ok", title, (kind, loader, text))
        except Exception as exc:  # noqa: BLE001
            return ("fail", title, str(exc)[:160])

    with cf.ThreadPoolExecutor(max_workers=4) as pool:
        for status, title, payload in pool.map(work, items):
            if status == "ok":
                kind, loader, text = payload
                save(person, kind, title, loader, text)
                stats["ok"] += 1
                stats["chars"] += len(text)
                print("[%s] 저장 %-70s %8d자" % (person, title[:70], len(text)), flush=True)
            elif status == "skip":
                stats["skipped"] += 1
            else:
                stats["failed"].append((title, payload))
                print("[%s] 실패 %s — %s" % (person, title[:70], payload), flush=True)
    return stats


def main(argv):
    if argv and argv[0] == "extra":
        person, kind, title, url = argv[1:5]
        print(run_person(person, [(kind, title, ("url", url))]))
        return
    people = argv[1:] or list(SOURCES)
    for p in people:
        s = run_person(p)
        print("== %s: 저장 %d, 건너뜀 %d, 실패 %d, %d자" % (p, s["ok"], s["skipped"], len(s["failed"]), s["chars"]), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
