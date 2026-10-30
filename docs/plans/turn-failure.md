# 4단계 구현 계획: 턴 실패

## Context

3단계까지 턴이 실패하면 경고만 남기고 아무것도 기록하지 않는다(`runTurn`의 `decideOutput`이 예외를 삼킨다). 그래서 다음 문제가 남아 있다.
- 실패한 작업을 루프가 백오프 없이 바로 다시 고른다.
- io 뒤 커밋 전에 죽으면 재시작 직후 같은 호출이 또 나간다. 자동 재시작과 만나면 과금이 끝없이 이어진다.
- 같은 입력에서 출력 실패가 반복되는 트리거가 영원히 다시 골라져 판정·계획·다른 개입을 모두 막는다.
- 운영자가 실패를 알 길이 로그뿐이다.

이번 단계는 정본 §9.4의 시도 선기록, `fail_turn`, 트리거 포기, 운영자 알림을 넣는다. §6.2의 운영자 알림을 정리 포기(§9.6)에도 연결한다. 실물 API를 붙이기 전에 꼭 있어야 하는 안전장치라 게이트보다 먼저 한다.

## 범위

**포함**
- **시도 선기록:** 턴 시작 tx에서 `failure_count`를 올리고 `turn_retry_at = now + backoff`를 쓴다. `failure_alert_after` 알림도 이 tx에서 검사한다. 성공 커밋(말 없는 턴 포함)이 지운다. 지우는 쪽은 이미 있다(`resetTurnFailures`).
- **`fail_turn`:**
  - 출력 실패(파싱·스키마)면 `output_fail_count`와 `output_fail_key`를 갱신한다. API 실패와 그 밖의 예외는 백오프만 한다.
  - `turn_max_attempts`에 닿으면 트리거를 포기한다.

    | 트리거 | 포기할 때 하는 일 |
    |---|---|
    | `open` | 예약을 지우고 `settle()` |
    | `user` | `id <= upto`인 `pending`을 `ignored`로 |
    | `continue`/`reply` | `close_flow('failed')` |

  - 포기한 뒤에는 `output_fail_*`만 지우고 운영자에게 알린다.
- **운영자 알림 `alertOperator`:** 로그에 남기고, 보류가 `blocked`가 아니면 텔레그램으로도 보낸다.
  - 쓰는 곳은 셋이다: 턴 연속 실패, 턴 트리거 포기, 정리 포기(85, 85a).
- **바뀌는 테스트:** 기존 테스트 중 "실패 직후 바로 다시 돈다"를 기대하던 것을 백오프 시각으로 고친다(아래 "기존 테스트에서 바뀌는 것").

**제외**
- 게이트 단계: `gate()`, 보류 진입(107, 110). 선기록은 정본대로 게이트 뒤 자리에 둔다. 게이트는 그 앞에 끼워 넣으면 된다.
- 계획 단계: 계획 실패는 지금처럼 가짜의 `failPlan`이 기록한다(94, 120은 이미 있다).
- 압축 단계, 어댑터 단계: 그대로 둔다.

## 코드 작성 원칙 (이전 계획에서 이어짐)

사람이 읽기 쉬운 코드가 최우선이다.
- **이름:**
  - 이름만 보고 하는 일을 알 수 있게 한다. 함수는 동사구로 짓는다.
  - 정본 약칭(`fail_turn`, `key`, `upto`)은 하는 일을 말하는 이름으로 바꾼다(아래 표).
  - 불리언은 `is`/`has`로 시작하고, 시각 값은 `...At`으로 끝낸다.
- **주석:** 이름과 구조로 설명할 수 없는 이유에만 단다. 이번 단계의 예:
  - 왜 io 전에 시도를 기록하는가(크래시도 실패로 센다)
  - 왜 포기해도 `failure_count`를 지우지 않는가(트리거와 무관한 실패가 백오프 없이 다시 시작된다)
  - 왜 출력 실패만 포기로 세는가
  - 알림을 왜 outbox가 아니라 바로 보내는가
- **함수 하나는 한 단계의 추상만 다룬다.** `runTurn`은 "시도 기록 → 결정 → 실패면 `failTurn`, 아니면 지우기·커밋"으로 위에서 아래로 읽히게 쓴다.
- **패턴:**
  - Repository: SQL은 저장소 안에만 둔다.
  - 포기 동작은 트리거별 `switch` 하나에 모은다. `commitTurn`의 `declineToOpenFlow`와 같은 모양이다.
- **테스트:**
  - 테스트 이름은 정본 번호와 상황을 쓴다.
  - 본문은 주어진 상황 → 행동 → 기대 순으로 읽힌다.

### 정본 이름 → 코드 이름

| 정본 | 코드 | 하는 일 |
|---|---|---|
| 시도 선기록 tx | `recordTurnAttempt(ctx)` | 횟수·재시도 시각을 기록하고, 알릴 차례면 알린다 |
| `fail_turn(kind, x, upto, 오류)` | `failTurn(ctx, { task, lastSeenUserMessageId, error })` | 실패를 세고, 닿으면 포기한다 |
| `key(kind, x)` | `triggerKeyOf(task)` | `open:<id>` / `user` / `flow:<id>` |
| 트리거 포기 | `giveUpTrigger(ctx, task, lastSeenUserMessageId)` | 트리거별 포기 동작 |
| 출력 실패 판별 | `isOutputFailure(error)` | `LlmCallError`이고 `isOutputFailure`인지 |
| 운영자 알림 | `alertOperator(ctx, text)` | 로그 + (blocked가 아니면) 텔레그램 |

## 설계 결정

### 흐름

```
runTurn(task):
  recordTurnAttempt()                         # tx. 알릴 차례면 tx 뒤에 alertOperator
  pre: planDate, input, lastMessageIdBeforeIo, changes
  try: output = decideOutput(...)             # 결정 실패는 더 이상 삼키지 않는다. 되묻기 실패는 지금처럼 첫 출력
  catch error: failTurn(task, input.lastShownUserMessageId, error); return
  지우기, commitTurn(...)                     # 성공 커밋이 resetTurnFailures (이미 있음)
```

- **결정 실패는 모두 `failTurn`으로 간다.** `LlmCallError(api)`, `LlmCallError(output)`, 그 밖의 예외(도구 버그 등)가 여기에 해당한다. 출력 실패로 세는 것은 `LlmCallError(output)`뿐이다.
- **결정 뒤(지우기·커밋)에 던진 예외는 `failTurn`을 거치지 않는다.** 루프가 받아 로그를 남긴다. 선기록이 이미 실패 한 번으로 세어 두었으므로 크래시와 같게 다뤄진다.

### `recordTurnAttempt`

```
tx: isAlertDue = failure_count == failure_alert_after
    failure_count++; turn_retry_at = now + turnBackoffDelaySec(failure_count)
if isAlertDue: alertOperator("턴이 N번 연속 실패했다. 다음 재시도는 HH:mm 뒤다.")
```

- 등호로 비교하므로 알림은 연속 실패 구간마다 한 번이다. `failure_alert_after=3`이면 네 번째 시도를 시작할 때 알린다(78).
- 백오프 함수 `turnBackoffDelaySec`은 이미 `src/time.ts`에 있다.

### `failTurn`

```
tx: if isOutputFailure(error):
      key = triggerKeyOf(task)
      count = harnessState.countOutputFailure(key)   # 같은 키면 +1, 다르면 1
      if count >= turn_max_attempts:
        giveUpTrigger(task, lastSeenUserMessageId)
        harnessState.clearOutputFailures()           # failure_count·turn_retry_at은 그대로
        isGivenUp = true
로그: 턴(trigger) 실패 N번째, 출력 실패면 count/turn_max_attempts
if isGivenUp: alertOperator("<트리거 설명>를 포기했다. 출력 실패 N번. 마지막 오류: <error.message>")
```

- `giveUpTrigger`:
  - `open`: `reservations.delete` + `scheduleFollowUpsForUncoveredGoals`
  - `user`: `messages.markPendingIgnoredUpTo(upto)`
  - `continue`/`reply`: `closeFlow(ctx, flowId, "failed")`. `inTransaction`이 중첩을 허용하므로 바깥 tx 안에서 부른다.
- 포기할 트리거 설명은 입력의 계기 줄과 같은 말을 쓴다(`AI 개시(개시 예약 #4)` 등). `describeTrigger`를 `turn-input.ts`에서 export해 재사용한다.

### `alertOperator`

- 텔레그램 `sendMessage`로 바로 보낸다. `messages` 테이블과 outbox에는 넣지 않는다.
  - 넣으면 다음 턴 입력의 흐름 대화나 흐름 밖 메시지에 "나:" 줄로 나와, 모델이 자기가 한 말로 읽는다.
  - 운영자와 사용자가 같은 사람이라 같은 채팅으로 간다(§6.2).
- 문구 앞에 `[aigan 알림]`을 붙여 대화 메시지와 구분한다.
- 보류가 `blocked`면 로그만 남긴다. 보내기가 실패하면 로그만 남긴다. 알림이 실패했다고 작업을 실패로 만들지 않는다.
  - 알림 중 받은 403으로는 `blocked`에 들어가지 않는다. 다음 outbox 전송이 같은 403을 받아 들어간다.
- 커밋 tx 안에서 보내지 않는다. tx에서 알릴지만 정하고, 보내기는 tx 뒤에 한다.
- 정리 포기 `giveUpCleanup`도 `alertOperator`를 부른다. 지금은 로그만 남긴다.

### 저장소 추가 (`harness-state.ts`)

- `recordTurnAttempt(retryAt)`: `failure_count + 1`과 `turn_retry_at`을 쓰고 새 횟수를 돌려준다.
- `countOutputFailure(key)`: 횟수를 올리고 새 횟수를 돌려준다.
- `clearOutputFailures()`

### 기존 테스트에서 바뀌는 것

모두 "실패 직후 바로 다시 돈다"던 3단계의 임시 동작을 기대하던 테스트다. 정본(80, 82)이 백오프 뒤 재시도를 요구하므로, 시각만 고치고 무엇을 보는지는 그대로 둔다.

| 테스트 | 지금 | 바뀐 뒤 |
|---|---|---|
| 114 | 재시작 직후(10:01) 같은 턴 | 선기록한 `turn_retry_at`(10:10) 뒤에 같은 턴. 80과 합친다 |
| 11.10 "재시도에도 읽을 수 없으면" | 다음 메시지에 바로 다음 턴 | 77로 이름을 바꾼다. 백오프 뒤에 다음 턴이 돈다. `output_fail_*`도 확인한다 |
| 11.10 API 오류 | 바로 새 대화로 재시도 | 재시도 요청이 `turn_retry_at` 뒤에 나간다 |
| 48h | 10:11에 다음 시도 | 다음 시도는 백오프 뒤다. 3번째 실패에서 `close_flow('failed')`까지 보도록 82c와 합친다 |

## 파일

```
src/
├── db/repositories/harness-state.ts   # + recordTurnAttempt, countOutputFailure, clearOutputFailures
├── llm/input/turn-input.ts            # describeTrigger export
└── worker/
    ├── operator-alert.ts              # 새로: alertOperator
    ├── turn-failure.ts                # 새로: recordTurnAttempt, failTurn, giveUpTrigger, triggerKeyOf
    ├── turn.ts                        # 시도 기록, 결정 실패 → failTurn
    └── cleanup.ts                     # giveUpCleanup → alertOperator
test/
├── fakes/telegram.ts                  # + 알림만 걸러 보는 도우미(alerts)
└── spec/
    ├── 11.10-turn-failure.test.ts     # 76a–82h
    ├── 11.06-in-flow.test.ts          # 48h → 82c와 합침(또는 11.10으로 옮김)
    ├── 11.11-cleanup.test.ts          # 85, 85a에 알림 확인
    └── 11.15-recovery.test.ts         # 114를 80으로
docs/plans/turn-failure.md             # 이 계획. docs/README.md에서 링크
```

## 테스트 전략 (이전 계획에서 이어짐)

- **기본은 e2e다.** 앱을 부팅하고 각본 모델로 실패를 낸다(`malformed()`, `apiError()`, 끝나지 않는 각본 + `restart`).
- **관찰은 바깥에서 보이는 것 위주로 한다:**
  - 언제 다음 시도가 나갔는지(`llm.log`의 시각)
  - 트리거가 어떻게 됐는지(예약, 메시지 `triage`, 흐름 `end_reason`)
  - 알림이 몇 번 갔는지(`telegram.alerts`)
  - `harness_state` 행은 정본이 값으로 정한 것(76a, 77, 82f, 82g)만 직접 본다.
- **"io 전에 기록"은 io 중에 확인한다.** 각본 안에서 `harness_state`를 읽는다.
- **단위 테스트는 추가하지 않는다.** 백오프 함수는 이미 단위 테스트가 있고, 나머지는 상태 전이라 e2e가 맞다.

## 이번 단계 테스트

| # | 넣는 것 |
|---|---|
| 76a | 각본 안에서 `failure_count=1`, `turn_retry_at=now+600`이 보이고, 성공 커밋 뒤 둘 다 지워져 있다. 말 없는 판정 턴(무시)도 지운다 |
| 77 | 재시도까지 출력 실패: `failure_count`·`turn_retry_at` 유지, `output_fail_count=1`, `output_fail_key='user'`. API 오류: `output_fail_*` 그대로 |
| 78 | `failure_alert_after=3`, API 오류 연속 다섯 번: 네 번째 시도 시작에 알림 1번. 다섯 번째에는 알림이 없다 |
| 79 | 22:50 답장 턴 실패로 백오프가 23:00을 넘김(블랙아웃 23:00). 23:00에 `Close(blackout)`, 이어서 정리·날 넘김이 돈다. 계획은 백오프가 끝난 뒤 돈다 |
| 80 (114 합침) | 판정 턴 io 중 크래시 → 1분 뒤 재시작해도 10:10까지 호출이 없고, 10:10에 같은 턴이 돈다 |
| 80a | 크래시와 재시작이 반복된다. 호출 간격이 10, 20, 40, 80, 120, 120분으로 늘어난다. 알림은 네 번째 시도에서 1번 |
| 81 | 실패 뒤 성공: `failure_count=0`, `turn_retry_at=NULL`이고, 다음 작업이 바로 골라진다 |
| 82 | 실패한 `Turn(open)`: 예약이 `fired`로 남고, 백오프 뒤 입력의 계기가 같은 `개시 예약 #N`이다 |
| 82a | `Turn(open)` 출력 실패 3번: 예약 삭제, 걸린 목표에 `harness` 후속 확인, 알림. 다음 작업은 `turn_retry_at` 뒤 |
| 82b | `Turn(user)` 출력 실패 3번: 본 `pending`은 `ignored`. 마지막 시도의 io 중에 온 메시지는 `pending`으로 남는다. 알림 |
| 82c (48h 합침) | `Turn(continue)` 말 없이 이어가기 3번: `close_flow('failed')`, 정리 `pending`, 미응답은 흐름 밖 `pending`, 이어가기 예약이 다시 생기지 않음 |
| 82d | API 오류만 다섯 번: 포기하지 않는다. 예약 `fired` 유지 |
| 82e | 출력 → API → 출력 → 출력: 네 번째 시도(세 번째 출력 실패)에서 포기 |
| 82f | 출력 실패 2번 뒤 성공: `output_fail_count=0` |
| 82g | `Turn(user)` 출력 실패 2번 뒤 개시 예약 발화, `Turn(open)` 출력 실패 1번: 포기하지 않는다. `output_fail_key='open:<id>'`, 횟수 1 |
| 82h | 모든 턴이 출력 실패: 판정 턴을 포기한 뒤 다음 트리거(개시)의 첫 시도도 커진 백오프 뒤에 나간다(`failure_count`가 이어진다) |
| 85, 85a | 정리를 포기하면 알림이 1번 간다 |

## 테스트 계획 자체 검증

| 처음 생각 | 문제 | 고친 것 |
|---|---|---|
| 76a를 성공 뒤의 `harness_state`로만 확인 | 선기록을 커밋 때 해도 통과한다. 크래시 보호가 빠져도 모른다 | 각본 안(io 중)에서 읽는다 + 80 크래시 테스트 |
| 80a를 `failure_count`만 보고 확인 | 횟수가 맞아도 재시작 직후 호출이 나가면 과금 보호가 깨진다 | 호출 시각 간격을 본다 |
| 알림을 "보냈는가"만 확인 | `==` 대신 `>=`로 쓰면 매 시도 알림이 가도 통과한다 | 정확한 횟수를 본다(78, 80a) |
| 82b에서 `ignored`만 확인 | `upto` 대신 전부 `ignored`로 만들어도 통과한다 | io 중 도착 메시지는 `pending`으로 남는지 본다 |
| 82h를 포기 횟수로 확인 | 포기 때 `failure_count`를 지우는 실수를 못 잡는다 | 포기 다음 트리거의 첫 호출 시각을 본다 |
| `fail_turn` tx 중 크래시를 따로 테스트 | 프로세스 안에서는 tx 중간에 죽일 수 없다. 롤백되면 io 중 크래시와 같은 상태다 | 80으로 갈음하고, 이 사실을 문서에 적는다 |
| 48h와 82c를 따로 두기 | 같은 경로(이어가기 스키마 위반 → 포기)를 두 번 세운다 | 하나로 합치고 이름에 두 번호를 쓴다 |

남는 한계: 실제 프롬프트가 깨졌을 때의 출력 실패 모양은 각본으로 흉내만 낸다. 어댑터 단계의 수동 스모크에서 본다.

## 순서 (커밋 단위)

1. **운영자 알림:** `alertOperator`, 정리 포기에 연결, 텔레그램 가짜의 `alerts`. 85, 85a.
2. **시도 선기록과 `failTurn`:**
   - 코드를 넣고, 기존 테스트 4개를 고친다(위 표).
   - 바뀐 이유는 커밋 메시지에 적는다.
3. **턴 실패 e2e:** 76a–82h, 79.
4. **문서:**
   - `docs/plans/turn-failure.md`(이 계획 + 구현 결과)를 쓰고 `docs/README.md`에 링크한다.
   - `llm-executor.md`의 "턴 실패 단계로" 항목에 처리 결과를 적는다.

단계마다 `pnpm check`를 통과시킨 뒤 커밋하고 push한다.

## 검증

- `pnpm check`(fmt, lint, typecheck, test)가 통과해야 한다.
- 기존 222개 테스트 가운데 위 표의 4개 말고는 기대값이 바뀌지 않아야 한다.
- 손으로 따라가 볼 예 (82a):
  - 10:00 개시 예약 #2(목표 #1)가 발화하고, 각본은 늘 `malformed()`를 낸다.
  - 시도 시각은 10:00, 10:10, 10:30이다(백오프 600·1200초). 세 번째 시도 뒤에 예약 #2가 지워진다.
  - 목표 #1에 `harness` 후속 확인이 잡히고, 알림이 1번 간다.
  - `failure_count=3`, `turn_retry_at=11:10`은 그대로 남는다. 다음 턴은 11:10 뒤에 돈다.

## 정본 대조

§6.2, §9.1(다음 기한의 턴 백오프는 이미 있다), §9.3(`turn_ok`는 이미 있다), §9.4, §9.6, §9.9, §11.10과 대조했다.
- **정본과 같게 둔 것:**
  - 선기록은 pre보다 앞이다.
  - 알림 검사는 선기록 tx에서 증가 전 값으로 한다.
  - 포기해도 `failure_count`와 `turn_retry_at`은 남긴다.
  - 되묻기 실패는 실패로 세지 않는다(62e는 그대로).
- **정본이 정하지 않아 정한 것** (문서에 남긴다):
  - 알림은 outbox를 거치지 않고 바로 보낸다.
  - 결정 뒤(지우기·커밋)의 예외는 `failTurn`을 거치지 않는다. 선기록이 크래시와 같게 센다.
  - 도구 버그 같은 예외는 출력 실패가 아닌 실패로 센다.

## 구현 결과

계획한 커밋 단위대로 들어갔다. `pnpm check`는 테스트 235개로 통과한다. 달라진 점과 알아둘 점은 아래와 같다.

- **알림은 로그에 `warn`으로 남긴다.** 테스트 장치가 `error` 로그를 버그로 보고 실패시킨다. 알림은 예상한 상황이므로 `warn`이 맞다.
- **`blocked` 중 알림 테스트는 뺐다.**
  - 보류 중에는 턴도 정리도 돌지 않는다. 그래서 지금 경로로는 `blocked`일 때 알림이 나갈 수 없다.
  - 검사는 정본(§6.2)대로 코드에 남겼다. 보류 진입 알림(§6.3)이 생기는 게이트 단계에서 이 분기를 쓰고 그때 테스트한다.
- **알림 문구** (하네스가 사용자에게 직접 하는 말이다. 모델은 보지 않는다):
  - `[aigan 알림] 턴이 N번 연속 실패했다. 이번 시도가 실패하면 YYYY-MM-DD HH:mm 뒤에 다시 한다.`
  - `[aigan 알림] 턴(<계기>)을 포기했다. 출력 실패 N번. 마지막 오류: <오류>`
  - `[aigan 알림] 흐름 N의 정리를 포기했다(N번 실패). 이 흐름의 기억 정리는 빠진다.`
- **포기 뒤 연속 실패 알림.** 포기해도 `failure_count`가 이어지므로, 포기 다음 트리거의 첫 시도가 연속 실패 알림을 낼 수 있다(82a). 정본대로다.
- **기존 테스트.** 계획한 4개(80/114, 77, API 오류, 48h→82c)에 12g가 더해졌다.
  - 12g는 지운 뒤 커밋 전에 죽는 경우다. 재시작 뒤의 턴이 이제 선기록한 백오프(10분) 뒤에 돈다.
  - 무엇을 보는지는 그대로다.
- **SQLite rowid 재사용.** 지운 예약의 id가 다음 예약에 다시 쓰일 수 있다(82a). 테스트는 예약 id에 기대지 않는다.
