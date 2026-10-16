# 가상 시리얼 쌍(맥·리눅스) — com0com 대용. 슬레이브 경로를 출력하고, 마스터로 들어온 바이트를 파일에 모은다.
# 실행: python3 tools/pty_pair.py <저장파일>   (stdin 닫히면 종료)
import os, pty, sys, select, tty
out = open(sys.argv[1], "ab")  # 추가 모드 — 테스트가 파일을 비워도 앞자리에 0 이 끼지 않게
m, s = pty.openpty()
tty.setraw(s)
print(os.ttyname(s), flush=True)
while True:
    r, _, _ = select.select([m, sys.stdin], [], [], 0.2)
    if m in r:
        try: d = os.read(m, 65536)
        except OSError: d = b""
        if d: out.write(d); out.flush()
    if sys.stdin in r and not sys.stdin.readline():
        break
