# 2단계 구현 계획: 흐름과 도구 (DB 연산만)

## Context

뼈대(fc532da)에는 LLM을 부르지 않는 하네스 전부가 들어갔다. 흐름 닫기(`closeFlow`), I3 보정, 날 넘김은 이미 실제 코드다.

하지만 턴·정리가 DB에 남기는 결과는 아직 테스트 가짜(`test/fakes/llm-tasks.ts`의 `FakeCommit`)가 직접 쓴다. 흐름 열기, 메시지 흡수, 이어가기 예약, 도구 효과가 여기에 해당한다.

큰 틀의 2단계는 "흐름 연산(§9.6)과 도구 검증(§9.5)을 LLM 없이"였다. 흐름 닫기는 이미 끝났으니, 이번 단계는 다음을 실제 코드로 옮긴다.
- **턴의 io 밖 절반**: 계획일 고정, 도구 실행·검증, 되묻기 분기, 커밋 tx(§9.4).
- **정리의 io 밖 절반**: 시도 선기록, 기억 도구 검증, 기억과 완료를 한 커밋으로(§9.6 `Cleanup`, §5.6).

LLM 자리에는 결정자(`TurnDecider`, `CleanupDecider`)를 주입한다. 테스트는 결정자를 각본으로 바꾼다. 각본은 "도구를 이렇게 부르고, 이런 출력을 낸다"까지만 정하고, 나머지는 실제 코드가 처리한다. 3단계에서 결정자를 LLM 실행기(입력 조립, 스키마, 도구 라운드)로 바꾸면 이번 e2e가 그대로 회귀 테스트가 된다.

## 범위

**포함**:
- 예약 시각 규칙(§2.4): 개시 예약 앞쪽 클램프·그날 끝 거부, 이어가기 클램프. I3 보정도 같은 규칙을 쓰게 정리한다.
- 턴 도구 8개(§9.5 첫 표)와 거부 규칙, 목록 밖 도구 거부.
- `TurnChanges`: 도구 효과를 모으고 다음 라운드가 반영된 상태를 읽는 작업 집합.
- `runTurn`: 계획일 고정, 결정자 호출, 되묻기 1회, 커밋 tx.
  - 커밋 tx가 맡는 일:
    - 말 없는 턴의 효과 버리기, 무시·개입 취소.
    - 흐름 열기와 흐름 밖 메시지 흡수(`trimmed` 포함).
    - 블랙아웃을 넘긴 개시 턴 취소.
    - 이어가기 메우기·클램프, `close_flow('agent')`.
    - 실패 상태 초기화.
- 기억 도구 4개(§9.5 둘째 표)와 `MemoryChanges`, 기억 저장소.
- `runCleanup`: 시도 선기록, 결정자 호출, 성공 커밋, 실패·최대 시도 처리.

**제외**:
- 3단계(LLM 실행기)로:
  - 입력 조립(51a, 58a, 61a 등)
  - 출력 스키마(48h)
  - 도구 라운드 상한
  - `llm_calls`
  - 입력 중 표시
  - io 중 도착 메시지 지우기(`busy`, 12 계열)
- 턴 실패 단계로:
  - 시도 선기록(`failure_count`·`turn_retry_at`)
  - `fail_turn`과 `output_fail_*`, 운영자 알림
- 그 밖:
  - 게이트·보류 진입
  - 압축
  - 계획 본체: 계획은 지금처럼 가짜 핸들러로 둔다.
  - CLI, 실물 어댑터

## 코드 작성 원칙 (이전 계획에서 이어짐)

사람이 읽기 쉬운 코드가 최우선이다. 주석을 많이 다는 것이나 빠르게 도는 것보다 앞선다.

- **이름만 보고 하는 일을 알 수 있게 한다.**
  - 함수는 동사구로 짓고, 반환값이나 효과를 이름에 드러낸다.
  - 정본의 약칭(`TurnTx`, `orphans`, `settle`)을 그대로 옮기지 않고, 하는 일을 말하는 이름으로 바꾼다(아래 표).
  - 불리언은 `is`/`has`로 시작하고, 시각 값은 `...At`으로 끝낸다.
- **주석은 이름과 구조로 설명할 수 없는 복잡한 로직에만 단다.** 이번 단계의 예:
  - 새 목표·예약 id를 미리 정해도 되는 이유(io 동안 다른 삽입자가 없음)
  - AI 개시 턴에서 `x`를 이미 지운 것으로 보는 이유(L5)
  - 그날 끝 이후를 클램프하지 않고 거부하는 이유

  무엇을 하는지 되풀이하는 주석이나 절 번호만 적은 주석은 달지 않는다.
- **함수 하나는 한 단계의 추상만 다룬다.**
  - 커밋 tx는 §9.4 순서가 위에서 아래로 읽히는 짧은 분기로 쓴다.
  - 각 분기는 이름 붙은 함수로 뺀다(`ignoreSeenPendingMessages`, `openFlowFor`, `replaceContinueOrClose`).
  - 도구 하나는 "인자 검증 → 거부 조건 → 효과" 세 줄로 읽히게 한다.
- **디자인 패턴**(아는 패턴을 따라 읽는 사람이 구조를 짐작할 수 있게):
  - **Unit of Work**:
    - `TurnChanges`와 `MemoryChanges`는 io 동안 바뀐 것을 메모리에 모은다.
    - 커밋 tx 안에서 저장소로 한 번에 반영한다. 실패하거나 말이 없으면 버린다.
    - 전체 커밋은 기존 `inTransaction`이 감싼다.
  - **Strategy**:
    - `TurnDecider`와 `CleanupDecider`는 "무엇을 할지 정하는 쪽"이다.
    - 이번에는 테스트 각본, 3단계에서는 LLM 실행기가 들어간다.
    - `runTurn`과 `runCleanup`은 어느 쪽이 들어오는지 모른다.
  - **Command + handler map**:
    - 도구는 이름 → `{ 인자 스키마(zod), 실행 }` 표다.
    - 목록 밖 이름은 표에 없으니 거부된다.
    - 3단계에서 같은 표로 OpenAI 도구 정의를 만든다(`z.toJSONSchema`).
  - **Repository**: SQL은 `db/repositories/` 안에만 둔다. 이번 단계의 새 저장소는 `memory.ts`이고, 기존 저장소에 몇 가지 연산을 더한다.
  - **Composition Root**: `boot`는 결정자를 받아 턴·정리 핸들러를 조립한다. 계획 핸들러는 지금처럼 주입한다.
- 테스트도 같은 기준이다.
  - 테스트 이름은 정본 번호와 상황을 쓴다(`"55: 개시 예약 상한에서 open_reserve는 거부되고 턴은 계속된다"`).
  - 본문은 주어진 상황 → 행동 → 기대 순으로 읽힌다.

### 정본 이름 → 코드 이름

| 정본 | 코드 | 하는 일 |
|---|---|---|
| `run Turn(kind, x)` | `runTurn(task)` | 계획일 고정 → 결정 → 되묻기 → 커밋 |
| `TurnTx` | `TurnChanges` | 턴 도구 효과의 작업 집합 |
| `MemoryTx` | `MemoryChanges` | 기억 도구 효과의 작업 집합 |
| 도구 호출 | `turnTools.use(name, args)` / `cleanupTools.use(...)` | 검증 후 효과 또는 거부 이유 |
| `orphans(kind, x, out)` | `findGoalsWithoutNextCheck(changes, output)` | 흐름이 없어지는 출력에서 다음 확인이 없는 목표 |
| `tx TurnTx` | `commitTurn(...)` | §9.4 커밋 tx |
| `Cleanup(g)` | `runCleanup(task)` | |
| §2.4 시각 범위 | `fitOpeningTime(at, day)`, `fitContinueTime(at, flow)` | 클램프하거나 거부 이유를 낸다 |
| `settle()` | `scheduleFollowUpsForUncoveredGoals()` | 기존 그대로. 시각 계산만 `fitOpeningTime` 규칙을 공유 |

## 설계 결정

- **도구 효과는 메모리에 모으고 커밋에서 반영한다.**
  - io 동안 DB 트랜잭션을 열어 두지 않는다. 같은 연결로 폴러가 메시지를 넣는다. 열린 tx에 직접 쓰면, 말 없는 턴이 효과를 버릴 때 그 메시지까지 함께 되돌아간다.
  - `TurnChanges`는 처음 쓸 때 다음을 읽어 둔다:
    - 현재 계획일의 활성 목표
    - 개시 예약 전체와 각각의 `goal_ids`
    - 방침 목록
  - 도구는 이 작업 집합을 바꾸고, 변경을 순서대로 기록한다. 다음 라운드의 검증과 읽기는 바뀐 작업 집합을 본다(60).
  - 새 목표·예약 id는 `MAX(id)+n`으로 미리 정해 LLM에 돌려주고, 커밋에서 그 id로 삽입한다.
    - io 동안 목표·예약을 삽입하는 쪽은 이 턴뿐이라 안전하다. 폴러는 메시지만, 타이머는 `state`만 바꾼다.
    - 이 이유를 주석으로 남긴다.
- **도구 인자 시각 형식**: 설정 시간대의 로컬 `YYYY-MM-DD HH:mm`.
  - 턴 입력(3단계)에도 같은 형식으로 보여 준다.
  - 형식이 틀리면 인자 검증 거부로 처리한다.
- **도구 결과**: `{ ok: true, ... }` 또는 `{ ok: false, reason }`.
  - 거부 이유에는 상한 값, 현재 개수·길이, 그날 끝 시각을 담는다(§9.5).
  - 3단계는 이것을 그대로 JSON으로 LLM에 돌려준다.
- **결정자 포트**:
  ```ts
  interface TurnDecider {
    begin(turn: TurnRequest): TurnConversation;   // TurnRequest = { task, planDate, tools }
  }
  interface TurnConversation {
    decide(): Promise<TurnOutput>;
    reconsider(goals: GoalWithoutNextCheck[]): Promise<TurnOutput>;   // 같은 대화를 잇는다
  }
  type TurnOutput = { messages: string[]; next: { kind: "continue"; at?: DateTime } | { kind: "end" } };
  ```
  - 결정자가 던지면 이번 단계에서는 턴을 버리고 로그만 남긴다. 실패 처리는 턴 실패 단계에서 한다.
  - `reconsider`가 던지면 첫 출력으로 커밋한다(62e).
  - 정리도 같은 모양이다. `CleanupDecider.decide(request)`가 던지면 실패, 끝까지 돌면 성공이다.
- **본 메시지의 끝(`upto`)**: 이번 단계에서는 pre 시점의 user 메시지 최대 id로 둔다(흐름 밖·미응답 전부). 3단계에서 "입력에 넣은 user 메시지의 최대 id"로 바꾼다.
- **흐름을 열 때의 `trimmed`**: 흐름 밖 user 메시지 중 최근 `outside_messages_max`개 밖의 것을 흡수하면서 `void_reason='trimmed'`로 표시한다.

## 파일

```
src/
├── db/repositories/
│   ├── goals.ts          # + update(progress, dueAt), countActive, findActiveOn(planDate)
│   ├── reservations.ts   # + updateOpening(at?, intent?, goalIds?), 예약별 goal_ids 일괄 조회
│   ├── messages.ts       # + 흐름 밖 흡수 시 trimmed 표시, 본 메시지까지만 ignored
│   ├── flows.ts          # + 흐름 열기(openedBy*, planDate)
│   └── memory.ts         # 새로: state, 칸 목록·읽기·쓰기·삭제
└── worker/
    ├── reservation-times.ts   # fitOpeningTime, fitContinueTime
    ├── tools/
    │   ├── turn-changes.ts    # TurnChanges
    │   ├── turn-tools.ts      # job_read, goal_*, open_*, memory_read
    │   ├── memory-changes.ts  # MemoryChanges
    │   └── cleanup-tools.ts   # memory_read, state_write, memory_write, memory_delete
    ├── turn.ts                # runTurn, TurnDecider, findGoalsWithoutNextCheck
    ├── turn-commit.ts         # commitTurn
    ├── cleanup.ts             # runCleanup, CleanupDecider
    └── boot.ts                # 결정자 주입으로 바꿈
test/
├── fakes/llm-tasks.ts         # 각본 결정자로 바꿈(아래)
├── unit/reservation-times.test.ts
└── spec/
    ├── 11.04-ai-open.test.ts
    ├── 11.05-user-open.test.ts
    ├── 11.06-in-flow.test.ts
    ├── 11.07-tools.test.ts
    ├── 11.08-close-settle.test.ts
    └── 11.11-cleanup.test.ts   # 정리 부분만. 압축은 뒤로
docs/plans/flow-and-tools.md   # 이 계획. docs/README.md에서 링크
```

## 테스트 전략 (이전 계획에서 이어짐)

**기본은 e2e.** spec 테스트는 내부 함수(`commitTurn`, `fitOpeningTime`, `TurnChanges`)를 직접 부르지 않는다. 앱을 실제로 부팅하고 바깥 경계로만 넣고 본다.

- **구동기는 그대로 쓴다.** `startApp`는 임시 DATA_DIR, 실제 `boot`, 실제 루프를 쓴다. 가짜는 시계, 텔레그램, 결정자(와 계획 핸들러)뿐이다.
- **각본 결정자**(`ScriptedLlm`이 바뀜):
  ```ts
  new ScriptedLlm()
    .onTurn((turn) => {
      const goal = turn.use("goal_create", { job_id: "sample", title: "산책", done_criteria: "..." });
      turn.use("open_reserve", { at: "15:00", intent: "확인", goal_ids: [goal.id] });
      return say("나가서 걸어", { continueAfter: { minutes: 30 } });
    })
    .onReconsider((turn) => end("내일 보자"))
  ```
  - 각본은 실제 `turnTools`를 부른다. 결과(성공 값 또는 거부 이유)는 테스트가 그대로 검사한다.
  - 출력 도우미는 `say`, `end`, `silent`, `silentEnd`다. 흐름을 열고 닫고 흡수하는 일은 실제 `commitTurn`이 한다.
  - 지금 `FakeCommit`의 `openFlow`, `endFlow`, `ignore`, `cancelOpening`, `createGoal`을 쓰는 e2e 35곳을 이 도우미로 옮긴다. 기대값은 바꾸지 않는다. 그래서 기존 e2e가 실제 커밋 코드의 회귀 테스트가 된다.
  - 기록 `llmTasks`에 되묻기를 `turn:<trigger>:reconsider`로 남긴다. 62c의 "호출 +1"을 이것으로 본다.
  - 계획 각본(`finishPlan`, `failPlan`)은 지금처럼 가짜 핸들러로 둔다.
- **정리 각본**: `.onCleanup((cleanup) => { cleanup.use("memory_write", {...}); })`. 던지면 실패다(`failCleanup` 대신 `throw`).
- **관찰**:
  - 도구 결과
  - 가짜 텔레그램 `sent`
  - `llmTasks`
  - DB 읽기 전용 조회. 목표·예약·기억은 바깥에서 볼 경로가 아직 없으니(입력 조립은 3단계) 조회로 본다.
- **단위 테스트는 경계값이 많은 순수 함수에만** 둔다.
  - `fitOpeningTime`·`fitContinueTime`: 그날 끝 직전·직후, 블랙아웃 끝 앞, `min_lead`, 자정 넘김 블랙아웃, DST.
  - 기억 제목 정규화: 앞뒤 공백, 1–100자.

## 이번 단계 테스트

| 절 | 넣는 것 | 미루는 것 |
|---|---|---|
| 11.3 | 13의 흡수(개시 턴 커밋이 판정 대기 메시지를 흡수, `id > upto`면 미응답) | |
| 11.4 | 23, 24, 25, 26, 27, 28, 30, 32 | 23a, 30a(입력), 29(입력 쪽), 31(지우기) |
| 11.5 | 33, 34, 36, 37, 39, + `trimmed` | 35(io 중 도착) |
| 11.6 | 43, 45, 46, 47, 47a, 47b, 48, 48i, 48j | 40–42는 이미 있음. 44·48a–48g(입력·지우기), 48h(스키마) |
| 11.7 | 49, 50, 50a, 51(스냅샷·`flow_goals`), 52–58, 58b–58f, 59, 60, 61(말 없는 턴), 61b, 61c | 51의 입력 부분, 51a, 58a, 61a, 61의 실패한 턴 |
| 11.8 | 62–62e, 63–69 전부 | |
| 11.9·11.9a | 73, 75, 75b | |
| 11.11 | 83, 84, 85, 85a, 90(정리에 턴 도구 없음), 90d(커밋 쪽), 90e, 90f, 90g, 90h, 90i | 압축(88–89c), 정리 입력(90a–90c, 90k), 90j(CLI) |

## 테스트 계획 자체 검증

| 처음 생각 | 문제 | 고친 것 |
|---|---|---|
| 큰 틀대로 도구 검증을 함수 호출 단위 테스트로 | 검증이 맞아도 커밋 반영, 말 없는 턴의 버림, 되묻기 누적(62d)이 틀릴 수 있다 | 각본 결정자로 실제 턴을 돌리고 도구 결과와 커밋 뒤 DB를 본다 |
| 11.8의 되묻기를 `findGoalsWithoutNextCheck` 단위로 | 되묻기는 "한 번만", "효과 누적", "두 번째 실패면 첫 출력 커밋"이 핵심이다. 셋 다 흐름 동작이다 | `runTurn`의 되묻기 분기를 실제 코드로 두고, `onReconsider` 각본으로 e2e |
| 시각 규칙을 e2e로만 | 그날 끝·DST·자정 넘김 조합이 많아 e2e로는 비싸다 | 경계값은 단위로, 대표 경우(57, 57a, 57c, 57d, 47a, 65, 65a)는 e2e로 둘 다 |
| 기존 e2e를 새로 쓰기 | 뼈대 단계에서 검증한 순서·시각 기대를 잃는다 | 각본만 바꾸고 기대값은 그대로 둔다. 하나라도 바뀌면 그 이유를 커밋에 적는다 |
| 기억 도구를 저장소 단위로 | 90d(기억과 완료가 한 커밋), 90e(커밋 전 종료), 90f(실패 시 버림)는 tx 경계 문제다 | `runCleanup` e2e. 90e는 응답이 안 오는 각본 + `restart`로 재현한다 |

남는 한계도 있다.
- 결정자가 각본이라 입력에 무엇이 들어갔는지는 못 본다(51a, 58a, 61a). 3단계에서 각본 completion이 받은 입력을 기록해 본다.
- 실패 처리는 턴 실패 단계 전까지 "버리고 로그"뿐이라, 실패한 턴 효과 버림(61의 절반)은 그때 본다.

## 순서 (커밋 단위)

1. **예약 시각 규칙과 저장소 연산**
   - `fitOpeningTime`, `fitContinueTime`과 단위 테스트.
   - I3 보정 시각 계산이 같은 규칙을 쓰게 정리한다. 기존 e2e는 그대로 통과해야 한다.
   - 저장소에 목표 갱신, 예약 수정, 흡수 시 `trimmed`를 더한다.
2. **실제 턴 커밋과 각본 결정자**
   - `TurnDecider`, `runTurn`(되묻기 빼고), `commitTurn`.
   - `boot`가 결정자를 주입받게 한다.
   - `ScriptedLlm`을 각본 결정자로 바꾸고, 기존 e2e 35곳을 옮긴다(전부 통과).
   - e2e: 11.4, 11.5, 11.6, 13, 73, 75, 75b.
3. **턴 도구와 `TurnChanges`**
   - 도구 표, 거부 규칙, 작업 집합, 커밋 반영.
   - e2e: 11.7.
4. **되묻기와 I3 보정**
   - `findGoalsWithoutNextCheck`, `reconsider` 분기.
   - e2e: 11.8.
5. **기억 도구와 실제 정리**
   - `memory.ts` 저장소, `MemoryChanges`, 정리 도구, `runCleanup`.
   - e2e: 11.11의 정리 부분.
6. **문서**
   - `docs/plans/flow-and-tools.md`(이 계획)
   - `docs/README.md` 링크
   - 뼈대 계획의 "DB에 상태를 직접 넣은 테스트" 중 이번에 실제 경로로 바뀐 것 표시

단계마다 `pnpm check`를 통과시킨 뒤 커밋하고 push한다.

## 검증

- `pnpm check`(fmt, lint, typecheck, test)가 통과해야 한다. 네트워크도 키도 필요 없다.
- 옮긴 기존 e2e 58개가 기대값 변경 없이 통과해야 한다.
- e2e 예 62d: 흐름 안 턴의 각본이 `goal_create`와 `end`를 낸다. 되묻기 각본은 그 목표로 `open_reserve`와 `end`를 낸다.
  - 흐름이 `agent`로 닫혀야 한다.
  - 목표는 `active`여야 한다.
  - 그 목표를 겨냥한 `source='turn'` 예약이 있어야 한다.
  - `harness` 예약은 없어야 한다.
  - `llmTasks`에 `turn:reply:reconsider`가 한 번 있어야 한다.
- e2e 예 90e: 정리 각본이 `memory_write` 뒤 영영 끝나지 않게 한다. 그 상태로 `restart`한다.
  - 기억은 비어 있어야 하고, 정리는 `pending`이어야 한다.
  - `cleanup_next_at`에 재시도해 한 번만 반영돼야 한다.

## 구현 결과

계획대로 들어갔고, 아래만 달라졌다.

- **커밋 단위.** 시각 규칙·저장소·도구·턴 커밋·정리는 코드 커밋 하나로 들어갔다.
  - 각본 가짜를 바꾸는 순간 기존 e2e가 실제 커밋을 타야 해서, 앞 단계만 따로 떼면 테스트가 깨진 커밋이 생긴다.
  - 테스트는 절마다 따로 커밋했다(11.4–11.6, 11.7, 11.8, 11.11).
- **결정자 주입.** `boot`는 결정자 둘을 따로 받지 않고 `createDeciders(ctx)` 하나를 받는다(`turn`, `cleanup`, `plan`).
  - 실제 결정자도 `ctx`(ChatClient, `llm_calls`)가 필요해서다.
  - 계획은 아직 작업 통째로 받는다.
- **이어가기 턴의 기본 각본.**
  - 말 없이 이어가는 출력은 이제 `runTurn`이 거부한다(48h의 자리).
  - 그래서 각본이 없을 때 이어가기 턴은 말 없이 끝낸다.
  - 기존 e2e의 기대값은 하나도 바뀌지 않았다.
- **결정 실패.** 턴 실패 단계 전까지는 아무것도 바꾸지 않고 경고만 남긴다.
  - 백오프가 없어서, 같은 출력 실패가 반복되면 같은 작업을 바로 다시 고른다.
  - 각본 가짜의 반복 상한은 작업 예외로 던져 이 경우를 잡는다.
- **기억 제목 정규화 단위 테스트**는 e2e(83의 앞뒤 공백, 90g의 빈 제목·101자)로 덮어서 따로 두지 않았다.
- **테스트 번호 대응.**
  - 61(말 없는 턴의 효과 버림)은 26, 34, 48, 48i가 본다.
  - 65b는 70이 본다.
  - 56과 58c의 `x` 부분은 한 테스트로 합쳤다.
- **DB에 직접 넣은 상태.** 34는 실패 상태 초기화를 보려고 `failure_count`를 심는다. 턴 실패 단계에서 실제 실패로 바꾼다.

## 3단계에서 처리한 것

위 "3단계로" 항목은 [`llm-executor.md`](llm-executor.md)에서 처리했다: 입력 조립(51a, 58a, 61a, 23a, 30a, 48a–48g), 출력 스키마(48h의 재시도), 도구 라운드 상한, `llm_calls`, 입력 중 표시, io 중 도착 메시지 지우기(12 계열, 31, 35, 44). `upto`는 "입력에 넣은 user 메시지의 최대 id"가 됐다.
