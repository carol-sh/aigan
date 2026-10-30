# 6단계 구현 계획: 계획(Plan) 실행기

## Context

계획은 아직 가짜다.
- `BootOptions.runPlan`으로 작업을 통째로 받는다. 테스트의 `FakePlan`이 `plans` 행, 예약, `last_plan_date`를 DB에 직접 쓴다.
- 그래서 지금은 다음을 하나도 거치지 않는다.
  - 실행기: 입력 조립, 출력 스키마, 도구 라운드, `llm_calls`, `daily_calls`
  - 시도 선기록과 백오프 (`failPlan`이 흉내만 낸다)
  - 예약 시각 범위(§2.4)와 I6 상한
- 게이트도 `boot`에 임시로 걸어 뒀다.

이번 단계는 정본 §5.2와 §9.6 `Plan()`을 실제 코드로 옮긴다. 턴·정리와 같은 실행기(`LlmConversation`)를 쓴다. 이게 끝나면 LLM 접점 셋(턴·계획·정리)이 모두 실물 경로를 탄다. 남는 것은 압축과 어댑터다.

## 범위

**포함**
- `runPlan(ctx, decider, task)`. 순서는 게이트 → 시도 선기록 → io → 성공 커밋 또는 실패 로그다.
- 계획 입력 조립과 렌더(§5.2).
- 출력 파서 `planOutputParser`.
- 도구는 `memory_read`만 준다.
- 커밋은 한 tx다.
  - `plans`를 upsert한다.
  - 개시 예약에 시각 범위를 적용하고, `at` 순으로 I6 상한까지 넣는다. 버리는 것은 로그에 남긴다.
  - `markPlanned`를 부른다.
- `boot`에서 `runPlan` 옵션과 임시 게이트를 없앤다. 게이트는 `runPlan` 안으로 옮긴다.
- 각본 모델이 계획도 실제 요청으로 받게 한다. `FakePlan`은 `ScriptedPlan`으로 바꾼다.
- 11.12 테스트(91–99)와 90의 계획 부분을 넣는다.

**제외**
- 압축(§6.5)은 다음 단계다.
- 실물 DeepSeek/OpenAI 클라이언트와 CLI는 어댑터 단계다.
- 계획 실패의 알림·포기는 넣지 않는다. 정본이 "실패: 로그"로만 정했고, 백오프 상한(7200초)이 비용을 묶는다.

## 코드 작성 원칙 (이전 계획에서 이어짐)

- **이름:** 함수는 동사구, 불리언은 `is`/`has`, 시각은 `...At`로 쓴다.
- **주석:** 이유에만 단다. 이번 단계의 예:
  - 왜 계획은 기존 예약을 건드리지 않는가
  - 왜 상한을 자른 시각 순으로 적용하는가
- **모양:** 정리와 같은 모양으로 둔다. worker의 `runPlan`과 `PlanDecider` 인터페이스, llm의 `LlmPlanDecider`가 입력을 조립하고 대화한다. SQL은 저장소 안에만 둔다.
- **테스트:** 이름은 정본 번호와 상황으로 짓고, 본문은 상황 → 행동 → 기대 순으로 쓴다.

### 정본 이름 → 코드 이름

| 정본 | 코드 |
|---|---|
| `Plan()` | `runPlan(ctx, decider, task)` (`worker/plan.ts`) |
| 성공 tx | `commitPlan(ctx, planDate, output)` (같은 파일) |
| `backoff(n)` | `turnBackoffDelaySec`를 `failureBackoffDelaySec`로 바꾼다. 턴과 계획이 함께 쓴다(§6.2) |
| §5.2 입력 | `assemblePlanInput`, `renderPlanInput` (`llm/input/plan-input.ts`) |
| 최근 종료 목표 | `goals.findClosedSince(since)` (새 쿼리) |

## 설계 결정

### 흐름

```
runPlan():
  if await holdIfOutOfBudget(ctx): return
  recordPlanAttempt(now + failureBackoff(plan_attempts+1))   # 시도 선기록
  planDate = 현재 계획일                                    # 턴처럼 pre에서 고정
  try output = await decider.decide({ planDate, tools })
  catch: logger.warn("계획이 실패했다(n번째)"); return     # 재시도 시각은 이미 기록
  commitPlan(planDate, output)
```

`planDate`를 pre에서 고정하는 이유가 있다. io가 블랙아웃 시작을 넘기면 옛 계획일로 커밋된다. `last_plan_date`가 옛 날이라 다음 계획이 다시 밀리고, 옛 예약은 날 넘김이 지운다. 턴과 같은 규칙이다.

### 출력 계약

```json
{ "body": "오전엔 글쓰기를 밀고, 점심 뒤 산책을 권한다",
  "openings": [{ "at": "2026-10-31 12:30", "intent": "점심 뒤 산책 권하기", "goal_ids": [3] }] }
```

- `body`는 비지 않은 문자열이어야 한다. `openings`는 배열이고 비어도 된다.
- 각 항목의 `at`은 턴과 같은 `YYYY-MM-DD HH:mm[:ss]` 형식이다. `intent`는 비지 않은 문자열이고, `goal_ids`는 넣지 않아도 된다.
- 형식이 틀리면 출력 전체가 파싱 실패다. 1회 재시도하고, 그래도 틀리면 계획 실패다. 턴의 `continue_at` 형식 오류와 같다.

### 커밋

```
tx{
  plans.save(planDate, body, now)
  fitted = 각 opening에 fitOpeningTime(…, planDate, now)    # 기존 함수 재사용
           ok가 아니면 로그 후 버림 (그날 끝 이후 / 남은 시간 없음)
  goal_ids 중 현재 계획일의 활성 목표가 아닌 것은 빼고 로그
  room = open_max_pending - (source != 'harness'인 기존 개시 예약 수)
  fitted를 자른 at 순(같으면 출력 순)으로 정렬, 앞 room개 삽입(source='plan'), 나머지는 로그
  markPlanned(planDate)
}
```

- **상한 계산:** 상한 계산은 턴 도구의 `countOpeningsUnderLimit`와 같다. `harness`가 낸 보정 예약은 세지 않는다.
- **기존 예약 처리:** 기존 예약은 지우거나 바꾸지 않는다(§2.6, 97·98). 그래서 되묻기도 `settle()`도 없다.
- **`goal_ids` 처리(정본에 없어 내가 정함):** 출력의 `goal_ids` 가운데 지금 활성 목표가 아닌 id는 빼고 예약은 남긴다.
  - 계획 예약은 `intent`만으로도 유효하다.
  - 계획은 보통 날 넘김 직후에 돌아 활성 목표가 없다. 그래서 이 경우는 드물다. 재시도로 낮에 돈 계획에서만 생긴다.

### 입력 (user 문서 절 순서)

| 절 | 내용 |
|---|---|
| 방침 | `- id: description` |
| 기억 | 턴과 같은 `renderMemory` |
| 활성 목표 | `- #id 제목 (job, 마감)`, 완료 조건, 진행 메모. 방침 사본은 넣지 않는다(계획은 목록만 본다) |
| 최근 종료 목표 | 지난 `recent_goal_days`일(`closed_at >= now - N일`), `- #id 제목 (job) [결과] 사유 — MM-dd HH:mm 종료`. 직전 계획일(계획일 - 1일)의 `expired`면 진행 메모 줄도 넣는다 |
| 남아 있는 개시 예약 | 턴의 `renderOpening`을 `transcript.ts`로 옮겨 함께 쓴다 |
| 계획일 | `계획일`, `깨어 있는 구간`(블랙아웃 끝 – 그날 끝), `지금` |

- system에는 `plan-rules.md`만 넣고 persona는 넣지 않는다(§5.5 표).
- "계획일" 절은 정본 입력 목록에 없지만 넣는다. 모델이 예약 시각을 내려면 날짜와 구간을 알아야 한다. 이벤트 블록과 같은 성격이다.

### 도구

`createPlanTools(ctx)`는 `memory_read` 하나만 준다. `memoryReadTool`을 재사용하고, 읽기는 `ctx.memory.findSection`으로 한다. 라운드 상한은 `max_tool_rounds`다(§5.4).

### 각본 모델

- `kindOf`가 계획을 알아본다. 도구가 `memory_read` 하나뿐이면 계획이다.
- `requestsOf`, `inputs`, `lastInput`이 `"plan"`도 받는다.
- `ScriptedPlan`:
  - `use(name, args)`
  - `finishPlan({ body?, openings?: { at, intent?, goalIds? }[] })`: `FinalAnswer`를 낸다. 시각은 `ScriptedTurn.time()`과 같이 `HH:mm`이면 오늘로 채운다.
  - `failPlan()`: API 오류를 낸다.
  - `malformed()`
- `runPlan`을 지우고 `BootOptions.runPlan`도 지운다.
- 기존 각본 `(plan) => plan.finishPlan(...)`은 반환값이 답이 되므로 그대로 쓴다. 블록 본문인 곳(11.09:96)만 `return`을 붙인다.

### 기존 테스트에서 바뀌는 것

| 대상 | 이유 | 바꾸는 것 |
|---|---|---|
| 부팅 10:00 계획을 거치는 낮은 `daily_call_limit` 테스트(11.14의 107–111b·87, 11.03의 20) | 계획이 이제 요청 1건을 쓴다 | 상한을 계획 몫만큼 올려 보는 것을 그대로 둔다. 새 날 계획도 요청을 쓰므로 해제 뒤 작업 목록이 달라지면 이유를 커밋 메시지에 적는다 |
| `llm_calls` 개수를 세는 테스트(11.07:448, 11.10 `llmCalls`) | 계획 행이 생긴다 | `kind`로 거르거나 기대에 계획 행을 넣는다 |
| 11.14의 보류 중 계획 테스트 | 5단계에서 미뤘다 | `plan_attempts`가 그대로인지 본다(게이트가 선기록 앞인지 확인) |

다른 기대값은 바뀌지 않아야 한다. 기존 계획 각본의 시각은 모두 깨어 있는 구간 안이라 자르지 않는다. 이건 구현 중에 확인한다.

## 파일

```
src/
├── time.ts                         # turnBackoffDelaySec → failureBackoffDelaySec
├── db/repositories/goals.ts        # + findClosedSince
├── llm/
│   ├── outputs.ts                  # + planOutputParser(timezone)
│   ├── plan-decider.ts             # 새로: LlmPlanDecider
│   └── input/
│       ├── plan-input.ts           # 새로: assemblePlanInput, renderPlanInput
│       ├── transcript.ts           # + renderOpening (turn-input에서 옮김)
│       └── turn-input.ts
└── worker/
    ├── plan.ts                     # 새로: PlanDecider, runPlan, commitPlan
    ├── tools/plan-tools.ts         # 새로: createPlanTools
    ├── turn-failure.ts             # 이름 변경 반영
    └── boot.ts                     # runPlan 옵션·임시 게이트 제거, LlmPlanDecider
test/
├── fakes/scripted-llm.ts           # FakePlan → ScriptedPlan, kindOf 계획
├── rig.ts                          # runPlan 제거, 주석에서 "계획" 가짜 언급 제거
└── spec/
    ├── 11.12-plan.test.ts          # 새로
    └── (기존 이관: 11.14, 11.03, 11.07, 11.10, 11.09)
docs/plans/plan.md                  # 이 계획 + 구현 결과 + 프롬프트 작성용 계약(계획 입력·출력). README 링크
```

## 이번 단계 테스트 (`11.12-plan.test.ts`)

| # | 넣는 것 |
|---|---|
| 91 | `00:00-08:00`. 10-30 10:00 부팅부터 10-31 10:00까지 계획이 10-30 10:00과 10-31 00:00에 한 번씩만 돈다. `plans` 2행, `last_plan_date`=10-31 |
| 92 | `23:00-07:00`. 10-30 23:00에 계획(10-31)이 돈 뒤 내려갔다가 10-31 01:00에 재시작해도 다시 돌지 않는다 |
| 93 | `23:00-07:00`. 10-31 23:00 진입에서 계획일 11-01로 다시 돈다 |
| 94 | 계획 실패가 두 번이면 600초, 1200초 뒤에 재시도한다(`plan_retry_at`). 그 사이 턴은 돈다. 계획 io 중에 죽으면 재시작 뒤 `plan_retry_at`까지 기다렸다 한 번만 돈다. 실패 경고는 로그에 남는다 |
| 95 | 입력을 확인한다. 지난 7일 안에 닫힌 목표는 나오고 8일 전 것은 빠진다. 직전 계획일 `expired`만 진행 메모가 나온다. state 전문, 칸 제목, 활성 목표, 남은 예약, 계획일 절도 본다. system은 `plan-rules.md`이고 persona는 없다. 도구 목록은 `memory_read`뿐이다 |
| 90(계획) | 계획에서 `goal_create`, `state_write`를 부르면 "쓸 수 없는 도구"로 거부된다. `memory_read`는 칸을 읽는다 |
| 96 | `open_max_pending`=3에 예약 5개를 내면, 자른 `at` 순으로 이른 3개를 넣고 2개는 로그에 남긴다 |
| 97 | 날 넘김이 전날 예약을 지운 뒤 계획이 돈다. 같은 날 다시 돈 계획(재시도)은 기존 턴 예약을 그대로 두고 더하기만 한다 |
| 98 | 기존 예약이 상한에 가까우면 새 예약만 잘린다. 기존 예약 id와 시각은 그대로이고 보정 예약도 생기지 않는다 |
| 99 | 그날 끝 이후는 버리고 로그에 남긴다. 과거는 `now+min_lead`로, 블랙아웃 안은 블랙아웃 끝으로 당긴다 |
| (goal_ids) | 활성 목표 id는 붙이고, 없는 id는 빼서 로그에 남긴다. 예약은 남는다 |
| (파싱) | 형식이 틀린 답을 내면 1회 재시도한다. 또 틀리면 계획 실패라 `plan_retry_at` 백오프로 간다. `llm_calls`는 `kind='plan'`, `flow_id` NULL 두 행이다 |

## 테스트 계획 자체 검증

| 처음 생각 | 문제 | 고친 것 |
|---|---|---|
| 96을 "3개 저장"으로만 확인 | 출력 순으로 잘라도 통과한다 | 출력 순과 `at` 순이 다르게 내고, 남은 `at`을 본다 |
| 96의 정렬 기준을 요청 `at`으로 | 과거·블랙아웃 시각은 당겨지므로 요청 순과 자른 순이 다를 수 있다 | 99와 묶지 않고, 정렬은 자른 시각 기준이라고 문서에 적는다 |
| 98을 새 예약 수로만 확인 | 기존 예약을 지우고 다시 넣어도 개수는 같다 | 기존 예약의 id와 `at`이 그대로인지 본다 |
| 94를 "재시도함"으로만 확인 | 선기록 없이 실패 뒤에 기록해도 실패 경로는 통과한다 | io 중 크래시 → 재시작 뒤 즉시 돌지 않음을 본다 |
| 게이트 위치를 확인하지 않음 | 게이트를 선기록 뒤에 두면 보류 해제 뒤 계획이 백오프만큼 늦는다 | 11.14 보류 중 계획에서 `plan_attempts`=0 |
| 95에서 "최근"을 계획일로 셀지 `closed_at`으로 셀지 | 정본은 "지난 N일" | `closed_at` 기준으로 정하고, 경계(7일 안·8일 전)를 둘 다 본다 |

남는 한계: 실제 모델이 이 계약대로 내는지는 프롬프트를 쓸 때와 어댑터 단계의 수동 스모크에서 본다.

## 순서 (커밋 단위)

1. **계획 실행기:** 파서, 입력, 도구, 결정자, `runPlan`/`commitPlan`, `boot` 연결, 백오프 이름 변경. 각본 모델을 `ScriptedPlan`으로 바꾸고 기존 e2e를 이관한다. 기대값이 바뀌는 테스트와 그 이유는 커밋 메시지에 적는다.
2. **11.12 e2e:** 91–99, 90(계획), goal_ids, 파싱, 11.14 보류 중 계획.
3. **문서:** `docs/plans/plan.md`(계획 + 구현 결과 + 프롬프트 계약)와 `docs/README.md` 링크. 실행기 문서(`llm-executor.md`)의 "계획은 아직 가짜" 줄에 이 문서 링크를 단다.

단계마다 `pnpm check`를 통과시키고 커밋·push한다.

## 검증

- `pnpm check`(fmt, lint, typecheck, test)가 통과해야 한다. 지금은 243개이고, 새 테스트만큼 늘어난다.
- 손으로 따라가 볼 예(91):
  - 10-30 10:00 부팅. 계획이 밀려 있어 게이트를 지나고, 선기록(`plan_attempts`=1, `retry_at`=10:10) 뒤 요청 1건을 보낸다.
  - 커밋: `plans`(10-30)를 쓰고 `last_plan_date`=10-30, `plan_attempts`=0으로 둔다.
  - 10-31 00:00 블랙아웃 시작. 날 넘김 뒤 계획이 밀려 다시 돈다. `plans`(10-31)를 쓰고, 예약은 08:00 이후로 자른다.

## 정본 대조

§2.4, §2.6, §5.2, §5.4, §5.5, §5.6(계획은 읽기만), §6.1, §6.2, §9.3(3번), §9.6 `Plan()`, §11.12와 대조했다.
- **정본과 같게 둔 것:**
  - 시도 선기록, 실패는 로그만
  - 계획일당 1행 upsert
  - 시각 범위와 상한 `at` 순
  - 기존 예약은 건드리지 않음
  - `memory_read`만 줌
  - persona 없음
- **정본이 정하지 않아 정한 것** (문서에 남긴다):
  - 출력 JSON 키 이름(`body`, `openings`, `goal_ids`)
  - 활성 목표가 아닌 `goal_ids`는 빼고 예약은 남김
  - "계획일" 절 추가
  - 최근 종료 목표는 `closed_at` 기준
  - 직전 계획일 = 계획일 - 1일
  - 상한 정렬은 자른 시각 기준

## 프롬프트 작성용 계약

`plan-rules.md`를 쓸 때 기준이다. 턴·정리의 계약은 [`llm-executor.md`](llm-executor.md)에 있다.

**입력**: system은 `plan-rules.md` 전문이다. user 문서는 아래 절이 이 순서로 온다. 절은 비어도 빠지지 않고 `(없음)`이 된다.

```
## 방침
- sample: 한 줄 설명

## 기억
아침형                                  # state 전문. 비었으면 "state: (비어 있음)"
칸: 습관, 약점

## 활성 목표
- #1 물 (sample, 마감 2026-10-30 18:00)
  완료 조건: 물 끝
  진행 메모: (없음)

## 최근 종료 목표
- #2 책 (sample) [expired] 날 넘김 — 10-29 10:00 종료
- #3 물 (sample) [expired] 날 넘김 — 00:01 종료
  진행 메모: 1리터                       # 직전 계획일의 expired만

## 남아 있는 개시 예약
- #1 2026-10-30 15:00 중간 확인 [목표 1] (turn)

## 계획일
계획일: 2026-10-30
깨어 있는 구간: 2026-10-30 08:00 – 2026-10-31 00:00
지금: 2026-10-30 00:01
```

- 시각은 지금과 같은 날이면 `HH:mm`, 아니면 `MM-dd HH:mm`이다(최근 종료 목표).
- 날 넘김 직후에 도는 보통의 계획은 활성 목표와 남은 예약이 없다. 실패한 계획이 낮에 다시 돌 때만 보인다.

**출력** (`response_format: json_object`)

```json
{ "body": "하루 구상(자연어)",
  "openings": [{ "at": "2026-10-30 12:30", "intent": "점심 뒤 산책 권하기", "goal_ids": [1] }] }
```

- `body`는 비면 안 된다. `openings`는 빈 배열이어도 된다. `goal_ids`는 빼도 된다.
- `at`은 설정 시간대의 로컬 `YYYY-MM-DD HH:mm`이다. 초를 붙여도 받는다.
- 하네스가 고치는 것(로그에 남는다):
  - 그날 끝 이후는 버린다.
  - 지난 시각은 `now + min_lead`로, 블랙아웃 안은 블랙아웃 끝으로 당긴다.
  - 당긴 시각 순으로 `open_max_pending`까지만 넣는다. 턴이 만든 기존 예약도 이 수에 든다.
  - 활성 목표가 아닌 `goal_ids`는 뺀다.
- 형식이 틀리면 하네스가 한 번 더 묻는다. 문구는 턴과 같다(`출력이 형식에 맞지 않는다: …`).

**도구**: `memory_read`(`title`) 하나뿐이다. 결과는 `content`다.

## 구현 결과

계획한 커밋 단위대로 들어갔다. `pnpm check`는 테스트 254개로 통과한다. 달라진 점과 알아둘 점은 아래와 같다.

- **기존 테스트에서 바뀐 것** (첫 커밋 메시지에도 적었다):
  - 11.14의 낮은 상한은 부팅 계획 몫으로 1씩 올렸다(`ONE_TURN_A_DAY` = 2). 112는 두 날 모두 계획 요청을 센다.
  - 87은 이제 해제 뒤 정리와 새 날 계획이 함께 돈다. 5단계에서는 상한 1을 정리가 다 써서 계획이 다시 보류됐다.
  - 11.03 15: 계획 예약을 시각 순으로 넣으므로 id도 시각 순이다. 같은 시각 둘의 id 순은 그대로 본다.
  - 11.15 120: 시도를 io 전에 기록하므로 io 중에 죽으면 재시작 직후가 아니라 `plan_retry_at`(10분 뒤)에 다시 돈다. 94의 크래시 경우를 이 테스트가 맡는다.
  - 11.07, 11.10의 `llm_calls` 확인은 계획 행을 빼거나 목록에 넣었다.
- **보류 중 계획:** 5단계에서 미룬 테스트를 11.14에 넣었다. 계획이 상한을 만나 보류에 들어가도 `plan_attempts`는 0이다.
- **"직전 계획일" 표시:** 95는 10-23 목표(만료됨, 진행 메모 있음)가 메모 없이, 10-29 목표만 메모와 함께 나오는지 본다.
- **삭제된 예약 id는 다시 쓰인다.** `reservations`에 AUTOINCREMENT가 없어서다. 99가 그렇게 기대한다. 동작에는 영향이 없다.
- **로그 문구:**
  - `계획 예약을 버렸다(<사유>): <시각> <intent>`
  - `계획 예약에서 활성 목표가 아닌 것을 뺐다(#9): <시각> <intent>`
  - `계획일 <날짜>의 계획이 실패했다(<n>번째)` (warn)
