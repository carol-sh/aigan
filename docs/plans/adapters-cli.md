# 8단계 구현 계획: 어댑터와 CLI

## Context

하네스 로직은 다 들어갔지만, 아직 실제로 돌릴 수 없다.
- 바깥 경계 포트(`Clock`, `ChatClient`, `Telegram`, `Logger`)는 테스트 가짜만 있고 실물 구현이 없다.
- `src/main.ts`는 "not implemented"만 찍는다.
- 텔레그램 수신은 `recordIncomingMessage(ctx, update)`까지만 있고, 업데이트를 받아 오는 롱폴링이 없다.

이번 단계에서 할 일:
- 실물 어댑터(OpenAI 호환 LLM, grammY 텔레그램 전송·롱폴링, 시스템 시계, 콘솔 로그)를 만든다.
- CLI(§9.10) `serve`, `reset`, `memory`를 만든다.

이걸 마치면 실물 키로 하루를 돌려 볼 수 있다.

사용자 결정(이번 계획 질문):
- **DeepSeek은 이번에 뺀다.** `provider=deepseek`면 `serve`가 시작할 때 "아직 지원하지 않는다"로 거부한다.
  - 게이트의 잔액 코드와 테스트(가짜 잔액)는 그대로 둔다.
  - 잔액 어댑터와 통화 처리는 DeepSeek을 쓰게 될 때 한다.
- **어댑터는 로컬 가짜 HTTP 서버로 e2e 검증한다.**
  - 이를 위해 선택 설정 키 `llm_base_url`, `telegram_api_root`를 더한다. 비우면 공식 주소다.
  - `aigan serve` 프로세스 하나를 끝까지 도는 e2e도 넣는다.
  - 실물 키 확인은 수동 스모크로 문서에 남긴다.

## 범위

**포함**
- 설정: `llm_base_url`, `telegram_api_root`(선택, URL 검증).
- 어댑터(`src/adapters/`):
  - OpenAI 클라이언트
  - 텔레그램 전송(오류를 `TelegramError`로 옮김)
  - 텔레그램 롱폴러
  - `SystemClock`
  - `ConsoleLogger`
  - 잔액을 묻지 않는 `BalanceSource`(openai용)
- `boot` 옵션 정리: 연결을 설정에서 만들도록 `connect(config)`를 받는다(아래).
- CLI:
  - `serve`: 부팅, 폴링, 시그널 종료
  - `reset`: 잠금, 확인 입력, DB를 백업으로 옮김
  - `memory`: 읽기 전용 출력
  - `main.ts`의 명령 분기, `DATA_DIR` 환경 변수
- 테스트: 어댑터 e2e(가짜 서버), CLI 프로세스 e2e(90j 포함), `serve` 프로세스 e2e.
- `package.json` 스크립트, `examples/config.example`, 정본 §9.9에 키 두 줄, 수동 스모크 절차 문서.

**제외**
- DeepSeek 잔액 어댑터와 통화 처리.
- 프롬프트 본문(§10 1번)과 기본값 실측(§10 2번).
- 프로세스 관리(systemd 같은 것). 문서에 한 줄 예시만 둔다.

## 코드 작성 원칙 (이전 계획에서 이어짐)

- **이름:** 함수는 동사구, 불리언은 `is`/`has`, 시각은 `...At`.
- **주석:** 이유에만 단다. 이번 단계의 예:
  - 왜 SDK 재시도를 끄는가
  - 왜 오프셋을 저장하지 않아도 되는가
  - 왜 종료 때 진행 중 작업을 기다리다 포기하는가
- **경계:** 어댑터는 포트만 구현하고 하네스 규칙을 모른다. 재시도, 백오프, 429·403 처리는 이미 `send.ts`와 실행기에 있다. 어댑터는 오류의 모양만 옮긴다.
- **테스트:** 바깥에서 보이는 것을 본다. HTTP 요청 모양, 프로세스 출력, 종료 코드, DB 상태가 그것이다.

## 설계 결정

### 연결 주입: `boot({ connect })`

```ts
interface Connections { chat: ChatClient; telegram: Telegram; balance: BalanceSource }
interface BootOptions { dataDir; clock; logger; connect(config: Config): Connections }
```

- 어댑터를 만들려면 `bot_token`, `api_key`, `owner_chat_id`가 필요하다. 그런데 설정을 읽는 곳은 `boot`다.
- 그래서 `boot`가 설정을 읽은 뒤 `connect`를 부른다. 바깥에서 설정을 두 번 읽지 않는다.
- rig는 `connect: () => ({ chat: llm, telegram, balance })`로 바뀐다. 기존 테스트 동작은 그대로다.

### 어댑터

| 포트 | 구현 | 핵심 |
|---|---|---|
| `ChatClient` | `createOpenAiChatClient(config)` | `new OpenAI({ apiKey, baseURL: llm_base_url, maxRetries: 0, timeout: 180초 })`. 재시도는 §6.2 백오프가 맡는다. 타임아웃은 정본에 없다. 추론 모델을 고려해 180초로 둔다(문서에 남김) |
| `Telegram` | `BotTelegram` (grammY `Api`) | `owner_chat_id`로 `sendMessage`(평문), `deleteMessage`, `sendChatAction("typing")`을 보낸다. `GrammyError`는 `TelegramError(error_code, description, parameters.retry_after)`로 옮긴다. 네트워크 오류(`HttpError`)는 그대로 던진다. `send.ts`가 일반 실패로 재시도한다 |
| 수신 | `TelegramPoller` | 아래 |
| `Clock` | `SystemClock` | `DateTime.utc()`, `setTimeout`/`clearTimeout` |
| `Logger` | `ConsoleLogger` | `<ISO 시각> INFO …`. info는 stdout, warn·error는 stderr. 원인은 `stack`이 있으면 stack |
| `BalanceSource` | `balanceNotChecked` | openai용. 불리면 던진다. openai 게이트는 잔액을 부르지 않으니 불리면 버그다 |

- grammY `Api`는 `apiRoot: telegram_api_root`, `timeoutSeconds: 60`으로 만든다. 롱폴 30초에 여유를 둔 값이다.
- grammY 재시도 플러그인은 쓰지 않는다(§6.7).

### 롱폴러

```
TelegramPoller.start(onUpdate):
  offset = 0
  loop until stopped:
    try updates = await api.getUpdates({ offset, timeout: 30, allowed_updates: ["message"] }, abortSignal)
        for u in updates: onUpdate(u); offset = u.update_id + 1
        backoff 초기화
    catch: stopped면 끝. 아니면 warn 로그, backoff 대기(1초부터 두 배, 60초 상한)
stop(): stopped = true; abort()   # 대기 중인 롱폴을 바로 끊는다
```

- **오프셋은 저장하지 않는다.** 텔레그램은 확인하지 않은 업데이트를 다시 준다. 같은 업데이트는 `tg_update_id` 중복 검사(§9.1)가 버린다. 그래서 재시작해도 잃거나 두 번 넣지 않는다.
- `allowed_updates: ["message"]`라 `edited_message`는 오지 않는다. 와도 `recordIncomingMessage`가 버린다.
- `onUpdate`는 `harness.receiveUpdate`다. 동기 tx로 기록하고 루프를 깨운다.
- 오류(토큰 오류 401, 다른 폴러와의 충돌 409 포함)는 모두 같은 백오프로 다시 한다. 로그로 운영자가 안다.

### CLI

`DATA_DIR` 환경 변수가 필요하다. 없으면 사용법을 출력하고 종료 코드 1로 끝난다. 명령이 없거나 모르는 명령이면 종료 코드 2다.

**`serve`**

```
config 검증·잠금·마이그레이션(boot) → provider=deepseek면 거부(종료 1)
poller.start(update → harness.receiveUpdate) ; harness.start()
SIGINT/SIGTERM →
  poller.stop(); loop.stop()
  await loop.whenIdle()를 10초까지 기다림
    끝나면: harness.stop()(DB 닫기, 잠금 해제), 종료 0
    안 끝나면: 경고 로그, 종료 0   # 잠금 파일이 남지만 pid가 죽었으므로 다음 부팅이 가져간다
```

- 10초 안에 끝나지 않은 작업은 크래시와 같다. 시도는 선기록돼 있어서 재시작 뒤 백오프를 지킨다.
- 시작 실패(설정 오류, 잠금 거부, 필수 프롬프트 없음)는 메시지를 출력하고 종료 1이다.

**`reset`**

```
잠금 획득. 실패하면 "서버가 돌고 있다. 멈춘 뒤 다시" 출력, 종료 1
안내 출력: "DATA_DIR/aigan.db를 backup/<시각>/으로 옮긴다. 기억·목표·대화가 모두 처음으로 돌아간다. 계속하려면 reset을 입력하라"
stdin 한 줄이 "reset"이 아니면 "취소했다", 종료 1
aigan.db, aigan.db-wal, aigan.db-shm(있는 것만)을 backup/<yyyyMMdd-HHmmss>/로 옮김
잠금 해제, 옮긴 경로 출력, 종료 0
```

- DB가 없으면 "되돌릴 DB가 없다"를 출력하고 종료 0이다.
- 설정·프롬프트는 건드리지 않는다(§9.10).
- 백업 폴더 시각은 시스템 로컬 시각이다. 설정을 읽지 않고도 리셋할 수 있어야 해서다. 설정이 깨져 리셋하려는 경우가 있다.

**`memory`**

```
DB가 없으면 "아직 기억이 없다", 종료 0
new DatabaseSync(path, { readOnly: true })   # 잠금 없이, 마이그레이션 없이. 서버가 돌아도 된다(§9.10)
출력:
  [state] 갱신 2026-10-30 10:00:20 (흐름 #1)
  아침형

  [습관] 갱신 … (흐름 #1)
  저녁에 끝낸다
```

- 비어 있으면 `[state] (비어 있음)`이고 칸이 없으면 `(칸 없음)`이다.
- 출력 시각은 설정 시간대를 쓴다. 설정을 읽지 못하면 UTC로 출력한다.

### 설정 키 (§9.9 연결 표에 추가)

| 키 | 기본 | 의미 |
|---|---|---|
| `llm_base_url` | (비움) | OpenAI 호환 API 주소. 비우면 SDK 기본(OpenAI). 프록시나 테스트용 |
| `telegram_api_root` | (비움) | 텔레그램 Bot API 주소. 비우면 공식. 로컬 Bot API 서버나 테스트용 |

## 파일

```
src/
├── config.ts                     # + llm_base_url, telegram_api_root (z.url())
├── main.ts                       # 명령 분기, DATA_DIR, 종료 코드
├── adapters/
│   ├── openai-chat.ts            # createOpenAiChatClient
│   ├── telegram.ts               # BotTelegram, toTelegramError
│   ├── telegram-poller.ts        # TelegramPoller
│   ├── system-clock.ts
│   ├── console-logger.ts
│   └── connections.ts            # connectToServices(config): Connections. deepseek 거부, balanceNotChecked
├── cli/
│   ├── serve.ts                  # runServe(dataDir, io)
│   ├── reset.ts                  # runReset(dataDir, io)
│   └── memory.ts                 # runMemory(dataDir, io)
└── worker/boot.ts                # connect(config)
test/
├── rig.ts                        # connect로 바꿈
├── fakes/fake-api-server.ts      # node:http. 텔레그램(getUpdates 큐, 기록, 오류 주입) + OpenAI(completions 큐, 기록)
├── adapters/
│   ├── telegram.test.ts
│   └── openai-chat.test.ts
└── cli/
    ├── run-cli.ts                # 자식 프로세스로 main.ts 실행 도우미
    ├── serve.test.ts
    ├── reset.test.ts
    └── memory.test.ts            # 90j
docs/plans/adapters-cli.md        # 이 계획 + 구현 결과 + 수동 스모크 절차. README 링크
examples/config.example           # 두 키, deepseek 미지원 주석
package.json                      # "reset", "memory" 스크립트
```

`test/**/*.test.ts` 글롭이라 새 폴더도 `pnpm test`에 들어간다.

## 테스트

**어댑터 (`test/adapters/`, 가짜 서버, 프로세스 안)**

| 테스트 | 본다 |
|---|---|
| 텔레그램 전송 | `sendMessage`의 경로(`/bot<token>/sendMessage`), `chat_id`=owner, `text`, `parse_mode` 없음. `deleteMessage`의 `message_id`. `sendChatAction`의 `action: "typing"` |
| 텔레그램 오류 | 403이면 `isBlockedByUser`. 429 + `retry_after: 3`이면 `isRateLimited`, `retryAfterSec` 3. 400이면 `status` 400 |
| 롱폴러 | 업데이트 순서대로 전달. 다음 요청의 `offset` = 마지막 id + 1. `allowed_updates: ["message"]`. 서버 500 한 번 뒤 다시 받아 옴(첫 대기 시간은 테스트용으로 작게). `stop()`이 대기 중인 롱폴을 바로 끊음 |
| OpenAI | `/v1/chat/completions`로 params 그대로, `Authorization: Bearer <key>`. 응답을 그대로 돌려줌. 500이면 던지고 서버가 받은 요청은 1건(SDK 재시도 꺼짐) |

**CLI (`test/cli/`, 자식 프로세스)**

| 테스트 | 본다 |
|---|---|
| serve 하루 조각 | 가짜 서버에 붙여 `serve`를 띄운다(`message_debounce_sec=0`). 부팅 계획 요청 → 사용자 업데이트 → 판정 턴 요청 → `sendMessage`에 턴의 말. SIGTERM → 종료 0, 잠금 파일 없음. 끝난 뒤 DB의 `llm_calls`가 plan·turn 각 1건 |
| serve 두 번째 인스턴스 | 첫 serve가 도는 동안 두 번째가 잠금 메시지와 종료 1 |
| serve 시작 실패 | 설정 오류면 오류 메시지와 종료 1. `provider=deepseek`면 "아직 지원하지 않는다"와 종료 1 |
| reset | stdin `reset`이면 `backup/<시각>/aigan.db`가 생기고 원래 DB가 없어진다. 설정·프롬프트는 그대로, 종료 0. 다른 입력이면 아무것도 옮기지 않고 종료 1. 살아 있는 pid의 잠금이 있으면 거부하고 종료 1 |
| 90j memory | 기억(state, 칸 둘)을 넣은 DB. 잠금이 잡혀 있어도 출력이 위 형식이고, 실행 뒤 DB 내용이 그대로, 종료 0. DB가 없으면 "아직 기억이 없다" |
| main | 명령 없음·모르는 명령이면 사용법과 종료 2. `DATA_DIR` 없으면 종료 1 |

설정 단위 테스트(`test/unit/config.test.ts`)에는 `llm_base_url`이 URL이 아니면 `ConfigError`인지만 더한다.

## 테스트 계획 자체 검증

| 처음 생각 | 문제 | 고친 것 |
|---|---|---|
| 어댑터를 수동 스모크로만 | 오류 매핑(403→차단, 429→대기)이 틀려도 모른다. 하네스 테스트는 가짜 텔레그램이 처음부터 `TelegramError`를 던져서 이 변환을 거치지 않는다 | 가짜 서버로 실제 HTTP 응답에서 `TelegramError`까지 본다 |
| 롱폴러를 "받아 온다"로만 | 오프셋을 안 올리면 같은 업데이트가 계속 오는데, 중복 검사가 막아 하네스 테스트로는 안 드러난다 | 다음 요청의 `offset` 값을 직접 본다 |
| SDK 재시도를 확인하지 않음 | `maxRetries`를 빠뜨리면 실패마다 요청이 3번 나가 비용·`daily_calls`가 어긋나는데, 응답은 같아 보인다 | 500 응답에 서버가 받은 요청 수 1 |
| serve를 "뜬다"로만 | 연결 조립(chat·telegram·poller)이 하나 빠져도 부팅은 된다 | 업데이트 → LLM 요청 → `sendMessage`까지 끝까지 본다 |
| 종료를 확인하지 않음 | 시그널 처리가 없으면 잠금 파일이 남는다. 다음 부팅은 pid 검사로 넘어가지만, 정상 종료 경로가 검증되지 않는다 | 종료 코드 0, 잠금 파일 없음 |
| reset의 확인 입력을 안 봄 | 실수로 리셋하는 경로가 열려도 모른다 | 다른 입력이면 아무것도 안 옮김 |
| memory를 출력만 | 읽기 전용이 아니면 마이그레이션·WAL로 DB를 건드린다 | 잠금 중에 실행하고 내용 불변을 본다 |

남는 한계: 실제 OpenAI·텔레그램 응답 모양과 네트워크 오류 모양은 수동 스모크로만 확인한다(문서에 절차).

## 순서 (커밋 단위)

1. **어댑터:** 설정 키, `boot({ connect })`와 rig 수정, 어댑터 다섯과 `connections.ts`, 가짜 API 서버, 어댑터 테스트.
2. **CLI:** `main.ts`, `serve`, `reset`, `memory`, `package.json` 스크립트, CLI 테스트.
3. **문서:** `docs/plans/adapters-cli.md`(계획 + 구현 결과 + 수동 스모크 절차), `docs/README.md` 링크, 정본 §9.9에 두 키, `examples/config.example`.

단계마다 `pnpm check`를 통과시키고 커밋·push한다.

## 수동 스모크 (문서에 남길 절차, 실물 키)

1. `examples/config.example`과 `examples/prompts`를 `DATA_DIR`에 복사한다. `api_key`, `bot_token`, `owner_chat_id`, `model`, `daily_call_limit`을 채운다.
2. `DATA_DIR=… pnpm start`를 실행한다. 부팅 계획 요청이 성공하는지(`llm_calls`) 확인한다.
3. 봇에 말을 건다. 판정 턴과 답장이 오는지, 입력 중 표시가 뜨는지 본다.
4. `DATA_DIR=… pnpm memory`를 서버가 도는 중에 실행한다.
5. 봇을 차단했다 풀어 403 보류와 해제를 확인한다(선택).
6. Ctrl-C로 끄고 잠금 파일이 없어졌는지 확인한다.

## 검증

- `pnpm check`가 통과해야 한다. 지금은 264개다.
- 기존 테스트의 기대값은 바뀌지 않아야 한다. `boot` 옵션 모양만 바뀐다.
- 자식 프로세스 테스트는 실제 시간을 쓴다. 디바운스 0, 짧은 롱폴(가짜 서버가 바로 빈 배열로 답함)로 테스트 하나를 몇 초 안에 끝낸다.

## 정본 대조

§6.4, §6.6, §6.7, §9.1(폴러·중복), §9.2, §9.8(부팅), §9.9, §9.10과 대조했다.
- **정본과 같게 둔 것:**
  - SDK 재시도 끔, grammY 재시도 플러그인 없음
  - 평문 전송
  - `owner_chat_id` 외 채팅 무시
  - 단일 인스턴스 잠금
  - 리셋은 오프라인, 확인 입력, DB를 백업으로 옮김, 설정·프롬프트 유지
  - `memory`는 읽기 전용, 잠금 불필요
- **정본이 정하지 않아 정한 것** (문서에 남긴다):
  - 설정 키 `llm_base_url`, `telegram_api_root`
  - LLM 타임아웃 180초, 텔레그램 요청 타임아웃 60초
  - 폴러 오류 백오프 1초부터 60초까지
  - 종료 때 진행 중 작업을 10초까지 기다림
  - `DATA_DIR`은 환경 변수
  - 리셋 확인 단어 `reset`, 백업 폴더 이름은 로컬 시각
  - `provider=deepseek`는 `serve`가 거부(사용자 결정)

## 실행 방법

```
DATA_DIR/
├── config      # examples/config.example을 복사해 채운다
└── prompts/    # examples/prompts를 복사하고 본문을 쓴다
```

| 명령 | 하는 일 |
|---|---|
| `DATA_DIR=<경로> pnpm start` | 서버(`serve`). Ctrl-C나 SIGTERM으로 끈다 |
| `DATA_DIR=<경로> pnpm memory` | 기억을 출력한다. 서버가 돌아도 된다 |
| `DATA_DIR=<경로> pnpm reset` | 서버를 끈 뒤에만. `reset`을 입력하면 DB를 `backup/<시각>/`으로 옮긴다 |

- 종료 코드: 0 정상, 1 실패(설정 오류, 잠금, 취소), 2 사용법 오류.
- 로그: info는 stdout, warn·error는 stderr. 각 줄은 UTC ISO 시각으로 시작한다.
- 상시 실행은 프로세스 관리자에 맡긴다. 예: systemd `Restart=on-failure`, `Environment=DATA_DIR=…`, `ExecStart=pnpm start`. 크래시 뒤 재시작해도 시도 선기록과 백오프가 비용을 묶는다(§9.4).

## 구현 결과

계획한 커밋 단위대로 들어갔다. `pnpm check`는 테스트 282개로 통과한다. 기존 테스트의 기대값은 바뀌지 않았다. 알아둘 점은 아래와 같다.

- **`connectToServices(config, telegramApi)`:** `serve`가 롱폴러와 전송 어댑터에 같은 grammY `Api`를 쓰려고, `Api`를 바깥에서 만들어 넘긴다.
- **grammY의 `AbortSignal` 타입:** grammY는 Node용 shim 타입을 써서, 표준 `AbortSignal`을 `getUpdates`에 넘길 때 타입 단언이 하나 있다(`telegram-poller.ts`). 런타임은 표준 신호를 받는다.
- **`memory`의 갱신 표시:** state를 한 번도 쓰지 않았으면 갱신 시각 없이 `[state] (비어 있음)`이다. 출력 시각은 설정 시간대이고, 설정을 읽지 못하면 UTC다.
- **`serve` 테스트는 실제 시간을 쓴다.** 블랙아웃을 "지금부터 2–3시간 뒤"로 잡아, 언제 돌려도 판정 턴이 돈다. 테스트 하나가 1초 안팎이다.
- **SDK 재시도 끔**은 500 응답에 요청이 1건인지로 본다. 켜져 있으면 같은 테스트가 재시도 대기로 몇 초 걸리고 요청 수가 3이 된다.

## 수동 스모크 결과

아직 돌리지 않았다. 실물 키(`api_key`, `bot_token`, `owner_chat_id`)가 있는 곳에서 위 "수동 스모크" 절차대로 돌리고, 결과를 여기 적는다.
