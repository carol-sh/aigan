# 뼈대 구현 계획 (LLM 없는 전부)

## Context

정본(`docs/harness-design.md` 1.0)과 OpenAI 어댑터 노트까지 정리됐다. 코드는 `src/main.ts` 자리표시와 `test/unit/env.test.ts`뿐이다.

이번 단계는 **LLM을 부르지 않는 하네스 전부**를 실제 코드로 세운다. 다음이 들어간다.
- 수신, 타이머, 다음 기한
- 작업 고르기와 루프
- 흐름 닫기, 날 넘김, I3 보정
- 전송, 보류 해제, 부팅·재개

LLM 작업(턴·계획·정리)은 루프가 고르기만 하고, 실행은 주입한 핸들러에 맡긴다. 테스트에서는 이 핸들러를 각본 가짜로 바꾼다.

이렇게 자르면 다음 단계(도구 검증, LLM 실행기, 턴, 계획·정리·압축, 게이트)는 이 뼈대에 핸들러를 채우는 일이 된다. 이전 계획의 단계 0과 1을 합쳤다. 단계 2–4 중 LLM이 없는 부분(흐름 연산, 전송, 보류 해제, 부팅)도 앞으로 당겼다.

## 범위

**포함**:
- config, ports, time
- db: 연결, 잠금, 마이그레이션, 트랜잭션, 저장소
- 프롬프트 검증
- 생산자: 수신, 타이머, 다음 기한
- 워커: 작업 고르기, 루프, 흐름 연산, 전송, 보류 해제, 부팅·재개
- e2e 구동기와 가짜들

**제외**:
- `llm/` 전부
- 도구 검증(§9.5), 턴(§9.4)
- 계획·정리·압축 본체
- 게이트와 보류 진입(`daily_limit`·`balance`)
- CLI(`reset`·`memory`)
- 실물 어댑터(grammY 롱폴링, openai)
- `main.ts serve` 연결

## 코드 작성 원칙

사람이 읽기 쉬운 코드가 최우선이다. 주석을 많이 다는 것이나 빠르게 도는 것보다 앞선다.

- **이름만 보고 하는 일을 알 수 있게 한다.**
  - 함수는 동사구로 짓고, 반환값이나 효과를 이름에 드러낸다.
  - 정본의 약칭(`settle`, `rollover`, `select`)을 코드에 그대로 옮기지 않는다. 하는 일을 말하는 이름으로 바꾼다(아래 표).
  - 불리언은 `is`/`has`로 시작한다. 시각 값은 `...At`으로 끝낸다.
- **주석은 이름과 구조로 설명할 수 없는 복잡한 로직에만 단다.** 예:
  - 다음 기한에서 지난 값을 빼는 이유(L1)
  - 대기를 `timer_max_sleep_sec`로 자르는 이유(절전)
  - 블랙아웃 시작을 계획 재시도와 따로 넣는 이유

  무엇을 하는지 되풀이하는 주석이나 절 번호만 적은 주석은 달지 않는다. 정본과의 대응은 아래 이름표와 §6.7 디렉터리 구조가 맡는다.
- **함수 하나는 한 단계의 추상만 다룬다.** 작업 고르기는 정본의 §9.3 순서를 위에서 아래로 읽히는 짧은 분기로 쓴다. 각 분기의 조건은 이름 붙은 함수로 뺀다(`hasUnsettledInput`, `isTurnBackoffOver`).
- **디자인 패턴**(아는 패턴을 따라 읽는 사람이 구조를 짐작할 수 있게):
  - **Ports & Adapters**: 시계, 텔레그램, ChatClient는 `ports.ts`의 인터페이스다. 실물과 가짜는 어댑터다. 워커는 어댑터를 모른다.
  - **Repository**: SQL은 `db/repositories/` 안에만 둔다. 워커는 `flows.findOpen()`, `messages.findUnanswered(flow)`처럼 도메인 말로 읽는다.
  - **Unit of Work**: `inTransaction(db, () => ...)`. 흐름 닫기처럼 호출자 tx 안에서 돌아야 하는 연산은 중첩 호출이 바깥 tx에 합쳐진다. 나중에 TurnTx·MemoryTx도 같은 틀을 쓴다.
  - **Command + handler map**: 작업은 판별 유니온 `Job`이고, 실행은 `kind`별 핸들러가 맡는다. LLM 작업 핸들러는 주입한다.
  - **Composition Root**: 의존성 조립은 `boot`에서 한 번만 한다. 나머지 코드는 생성자나 인자로 받는다. 전역 상태는 두지 않는다.
- 테스트도 같은 기준이다. 테스트 이름은 정본 번호와 상황을 쓴다(`"74: 블랙아웃 진입 시 흐름이 닫히고 정리 → 계획 순으로 돈다"`). 본문은 주어진 상황 → 행동 → 기대 순으로 읽힌다.

### 정본 이름 → 코드 이름

| 정본 | 코드 | 하는 일 |
|---|---|---|
| `select()` | `pickNextJob()` | DB 상태에서 다음 작업 하나를 고른다 |
| `next_deadline()` | `nextDeadline()` | 타이머를 맞출 다음 시각 |
| 폴러 삽입 | `recordIncomingMessage(update)` | 텔레그램 update를 검사해 messages에 저장 |
| 타이머 발화 | `fireDueReservations()` | 시각이 된 예약을 `fired`로 |
| `close_flow` | `closeFlow(flow, reason)` | |
| `settle()` | `scheduleFollowUpsForUncoveredGoals()` | I3 보정 예약 삽입 |
| `rollover()` | `closePastPlanDays()` | 지난 계획일의 목표를 `expired`로, 예약을 삭제 |
| `Close(f,'blackout')` | `closeFlowForBlackout` 작업 | |
| `send_outbox()` | `sendOutbox()` | |
| `try_release()` | `releaseHoldIfRecovered()` | |
| `resume()` | `resumePendingWork()` | |
| `backoff(n)` | `turnBackoffDelay(n)`, `cleanupBackoffDelay(n)` | |

## 설계 결정

- **시각 저장**: ISO 8601 UTC(`...Z`)로 통일한다.
  - 문자열 비교와 SQL `MIN`·`MAX`가 그대로 맞는다. offset이 섞이면 DST가 있는 시간대에서 정렬이 깨진다.
  - `Z`도 offset이라 정본(§8)과 어긋나지 않는다.
  - 계획일은 로컬 `YYYY-MM-DD`.
- **Clock 포트**: `now(): DateTime`과 `setTimer(ms, onFire): cancel`.
  - 가짜 시계의 `advance(ms)`는 벽시계와 타이머를 함께 진행한다.
  - `suspend(ms)`는 벽시계만 진행하고 타이머는 멈춘다(기기 절전, 22a).
- **Telegram 포트**: `sendMessage(text)`, `deleteMessage(id)`, `showTyping()`.
  - 오류는 `TelegramError { status, retryAfterSec? }` 하나로 받는다.
  - 롱폴링 구동부는 어댑터 단계로 미룬다. update 모양은 grammY `Update`에서 필요한 부분만 쓴다.
- **Job**:
  ```ts
  type Job =
    | { kind: "closeFlowForBlackout"; flowId }
    | { kind: "turn"; trigger: "continue" | "reply"; flowId }
    | { kind: "turn"; trigger: "open"; reservationId }
    | { kind: "turn"; trigger: "user" }
    | { kind: "cleanup"; flowId }
    | { kind: "plan" };
  ```
  - `closeFlowForBlackout`은 뼈대의 핸들러가 처리한다. 나머지는 주입한 `LlmJobHandlers`가 맡는다.
  - 작업이 끝나면 루프가 `sendOutbox()`를 부른다.
- **루프** `JobLoop`: `start()`, `stop()`, `wake()`, `whenIdle()`, `stats`.
  - 다음 타이머는 `MIN(nextDeadline, now + timer_max_sleep_sec)`.
  - 작업 중 `wake()`는 플래그만 세운다.
  - `whenIdle()`과 `stats`는 e2e 관찰용이다.
- **잠금** `acquireInstanceLock(dataDir)`: `aigan.lock`을 `wx`로 만들고 pid를 쓴다. 이미 있으면 그 pid가 살아 있는지 본다. 살아 있으면 거부하고, 죽었으면 넘겨받는다.
- **보류 해제**:
  - `daily_limit`은 로컬 날짜가 바뀌면 해제한다.
  - `blocked`는 `hold_since` 이후 user 메시지가 오면 해제한다.
  - `balance`는 openai에서 진입하지 않으므로 자리만 둔다.

## 파일

```
src/
├── config.ts
├── ports.ts                 # Clock, ChatClient(타입), Telegram, TelegramError
├── time.ts                  # planDateAt, isInBlackout, blackoutEndOf, endOfDay, nextBlackoutStart, *BackoffDelay
├── prompts.ts               # loadPrompts(dir): 필수 파일, jobs/*.md frontmatter
├── db/
│   ├── open.ts              # openDatabase, migrate(user_version)
│   ├── transaction.ts       # inTransaction
│   ├── lock.ts              # acquireInstanceLock
│   ├── repositories/        # harnessState, flows, messages, reservations, goals
│   └── migrations/001_init.sql
├── producers/
│   ├── poller.ts            # recordIncomingMessage
│   ├── timer.ts             # fireDueReservations
│   └── deadline.ts          # nextDeadline
└── worker/
    ├── pick-next-job.ts
    ├── flow.ts              # closeFlow, scheduleFollowUpsForUncoveredGoals, closePastPlanDays
    ├── send.ts              # sendOutbox, splitForTelegram
    ├── hold.ts              # releaseHold, releaseHoldIfRecovered
    ├── boot.ts              # boot(Composition Root), resumePendingWork
    └── loop.ts              # JobLoop
test/
├── rig.ts                   # startApp: e2e 구동기
├── fakes/{clock,telegram,llm-jobs}.ts
├── unit/{time,config,split,db}.test.ts
└── spec/                    # e2e. §11 절마다 파일 하나
    ├── 11.01-boot.test.ts       # 3, 3a(목록 로드까지), 4
    ├── 11.02-receive.test.ts    # 7–11c
    ├── 11.03-select.test.ts     # 14–22a
    ├── 11.09-blackout.test.ts   # 70, 71, 72, 72a, 74
    ├── 11.09a-rollover.test.ts  # 75a, 75d, 75e, 75f
    ├── 11.13-send.test.ts       # 100–106
    ├── 11.14-hold.test.ts       # 104, 108, 109, 111, 111a, 111b
    └── 11.15-recovery.test.ts   # 113, 115–119
```

## 테스트 전략

**기본은 e2e.** spec 테스트는 내부 함수(`pickNextJob`, `nextDeadline`, `closeFlow`)를 직접 부르지 않는다. 앱을 실제로 부팅하고, 바깥 경계로만 넣고 본다.

- **구동** `startApp(opts)`:
  - 임시 `DATA_DIR`를 만들고 config와 `examples/prompts` 복사본을 넣는다.
  - 실제 `boot()`를 부른다(파일 DB, 잠금, 마이그레이션, 재개).
  - 실제 `JobLoop`를 돌린다.
  - 가짜는 경계 셋뿐이다: 시계, 텔레그램, LLM 작업 핸들러.
- **입력**(모두 실제 경로를 탄다):
  - `user(text)`: 가짜 텔레그램 update로 넣는다. `recordIncomingMessage`를 거친 뒤 `wake()`가 불린다.
  - `advance(dur)`, `advanceTo("09:00")`: 타이머가 발화하고, 루프가 한가해질 때까지 기다린다.
  - `suspend(dur)`: 기기 절전.
  - `restart({ downFor })`: 같은 `DATA_DIR`로 다시 부팅한다.
- **관찰**:
  - 가짜 텔레그램: `sent`, `deleted`.
  - LLM 작업 기록: 무엇이, 언제, 어떤 순서로 왔는지.
  - 루프 `stats`: 반복 수, 마지막으로 건 타이머.
  - DB 읽기 전용 조회: 마지막 수단.
- **LLM 작업 가짜**:
  - 테스트가 각본을 준다. 예: "개시 턴이면 흐름을 열고 한 줄 말하고 continue를 10분 뒤로".
  - 각본의 커밋 도우미는 가능한 한 실제 저장소와 `flow.ts`를 쓴다.
  - 턴 단계에서는 이 가짜를 실제 턴 + 가짜 `ChatClient`로 바꾼다. 테스트 본문은 그대로 두고 각본만 completion 각본으로 바꾸므로, 지금 쓴 e2e가 다음 단계의 회귀 테스트가 된다.
- **단위 테스트는 경계값이 많은 순수 함수에만** 둔다.
  - `time.ts`: 자정 넘김 블랙아웃, DST, 계획일.
  - config 검증.
  - 4096자 분할.
  - DB 제약 I1·I2: e2e로는 위반을 만들 수 없는 안전망이라 직접 확인한다.

## 테스트 계획 자체 검증

| 처음 계획 | 문제 | 고친 것 |
|---|---|---|
| 11.3을 select·기한 단위로 | 고르기가 맞아도 배선(타이머 재무장, 작업 중 `wake`, 작업 뒤 전송)이 틀릴 수 있다 | 루프를 돌리고 작업 기록과 시각으로 확인 |
| 다음 기한을 값 비교로 | L1 바쁜 루프는 값이 아니라 동작이다 | 19·20·22: 구간 동안 루프 반복 수와 LLM 작업 수를 센다 |
| 22a를 시계 함수로 | 타이머와 벽시계의 어긋남은 루프 없이 재현 안 됨 | `suspend` 뒤 `timer_max_sleep_sec` 안에 실행되는지 본다 |
| 복구·전송 재시작(101, 102, 113, 115–119)을 `:memory:` + 픽스처로 | 부팅 순서와 파일 DB 재개방을 거치지 않음 | `restart()`로 실제 재부팅. 며칠 다운(75f, 119)은 앞 구간을 e2e로 돌린 뒤 `restart({ downFor: "3d" })` |
| 3, 4를 검증 함수로 | 실제로 시작을 막는지 안 봄 | `startApp` 자체가 거부되는지 본다 |
| 13(흡수), 15 | 기대가 턴 커밋 효과라 가짜로 쓰면 각본을 시험하게 됨 | 뼈대에서는 순서만(15: 개시 → 정리 → 개시). 흡수는 턴 단계 |
| 18a, 111 | 턴 백오프·보류 상태를 만들려면 턴 실패·게이트가 필요 | 뼈대에서는 `restart` 전에 DB에 직접 심는다(이 두 종류만). 턴·게이트 단계에서 실제 경로로 바꾼다 |

남는 한계가 있다.
- LLM 경계가 작업 단위 가짜다. 그래서 io 중 도착(12 계열), 판정, 되묻기는 이 단계에서 못 본다.
- 프로세스 수준 e2e는 어댑터 단계에서 한다. `node src/main.ts serve`에 로컬 가짜 Bot API 서버(grammY `apiRoot`)와 가짜 OpenAI 서버(`baseURL`)를 붙인다.

## 순서 (커밋 단위)

e2e 구동기를 일찍 세운다. 이후 기능은 e2e 테스트를 먼저 쓰고 채운다.

1. **config·ports·time**: 순수 함수와 단위 테스트.
2. **db·프롬프트·부팅·루프 골격**:
   - 저장소, 트랜잭션, 잠금, 프롬프트 검증, `boot`.
   - 빈 고르기로 도는 `JobLoop`, rig와 가짜들.
   - e2e: 3, 4. "할 일이 없으면 `timer_max_sleep_sec`마다 깨고 LLM 작업이 없다"(22의 뼈대).
3. **수신·타이머·기한**: e2e 11.2와 11.3의 기한·디바운스 행(14, 17, 19, 20, 21, 22, 22a).
4. **흐름 연산과 고르기 전체**: e2e 11.3 나머지와 11.9, 11.9a.
5. **전송·보류 해제·재개·재시작**: e2e 11.13, 11.14의 해제 쪽, 11.15.

단계마다 `pnpm check`를 통과시킨 뒤 커밋하고 push한다.

## 미루는 테스트

- 12–12g: 턴 io 중 도착, 지우기.
- 1, 2, 5, 6: 계획, 리셋.
- 107, 110, 112: 게이트, 잔액, `daily_calls`.
- 11.4–11.8, 11.10–11.12, 11.16: 턴, 도구, 정리, 계획, 시나리오.

## 검증

- `pnpm check`(fmt, lint, typecheck, test)가 통과해야 한다. e2e는 임시 디렉터리의 파일 DB와 가짜만 쓴다. 네트워크도 키도 필요 없다.
- e2e 예 74: 흐름이 열린 앱에서 `advanceTo("00:00")`을 돌린다.
  - LLM 작업 기록이 `cleanup` → `plan` 순서여야 한다.
  - 그 사이 흐름 닫힘(`blackout`)과 날 넘김이 LLM 작업 없이 반영돼야 한다.
- e2e 예 19: `turn_retry_at`이 1시간 뒤인 상태에서 메시지를 넣고 30분을 진행한다.
  - LLM 작업은 0개여야 한다.
  - 루프 반복은 `30분 / timer_max_sleep_sec` 수준이어야 한다.
