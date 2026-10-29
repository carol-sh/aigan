# 지속형 예약 에이전트 하네스 (aigan-harness) 설계 문서

> 버전: 2.0
> 상태: 구현 설계 확정. 콘텐츠(프롬프트)는 운영자 소유.
> 범위: 예약 기반으로 스스로 깨어나 사용자와 상호작용하는 지속형 에이전트 하네스. 프롬프트 내용은 이 문서의 범위 밖이며, §6의 콘텐츠 계약을 따른다.
> 전제: 개인 서버 설치형, 단일 사용자. 텔레그램 FE.

---

## 1. 개요와 원칙

### 1.1 이 하네스가 하는 일

에이전트가 **정해진 시각에 스스로 깨어나** 사용자에게 말을 걸고, 사용자의 응답을 받아 대화를 이어가고, 다음에 언제 깨어날지를 스스로 정하는 하네스다. 대화는 흐름(flow) 단위로 열리고 닫히며, 닫힐 때 기억 쓰기 호출이 돈다. 비동기 작업은 별도 풀에서 마감과 함께 관리되고, 하루 단위 계획이 블랙아웃(사용자가 자는 시간)에 그려진다.

프롬프트 파일을 교체하면 비서, 코치, 튜터, 저널링 봇, 리마인더 등으로 용도가 바뀐다. 하네스는 그 파일들이 무엇을 하는지 모른다.

### 1.2 원칙

1. **직렬성은 구조로 보장한다.** 워커가 하나라서 동시성 문제가 없다. 수신 핸들러는 큐를 거치지 않고 버퍼에만 쓴다.
2. **불변식은 하네스가 강제한다.** "정지가 아니면 최소 1개 예약", "블랙아웃에는 발화하지 않음", "활성 흐름 최대 1개"는 프롬프트 부탁이 아니라 코드다.
3. **나머지는 LLM 재량이다.** 무엇을 시킬지, 어떻게 판정할지, 언제 다시 깨어날지는 하네스가 관여하지 않는다.
4. **읽기는 즉시, 쓰기는 트랜잭션.** 도구의 읽기는 결과를 바로 돌려주고, 상태 변경은 턴 성공 시 일괄 반영한다.
5. **하네스는 콘텐츠를 모른다.** 예약 행의 `prompt`는 파일 경로이고, 하네스는 그 파일을 읽어 컨텍스트에 넣을 뿐이다.

### 1.3 용어

| 용어 | 뜻 |
|---|---|
| **흐름** (flow) | 사용자와 접점을 갖는 상호작용의 단위. 열림과 닫힘이 있고, 여러 턴을 포함한다. 활성 흐름은 최대 1개 |
| **턴** (turn) | 흐름 안의 한 사이클. LLM 호출 한 번 + 사용자 응답 한 번(또는 응답 없이 닫힘) |
| **예약** (reservation) | 미래의 발화 시각을 담은 행. `at`, `slot`, `prompt`, `state`, `memo` |
| **슬롯** (slot) | 예약의 네임스페이스. `main` / `inbound` / `deadline`. 각 흐름은 자기 슬롯의 예약만 갱신한다 |
| **prompt** | 예약·흐름이 사용하는 프롬프트 파일 경로. 하네스는 이 파일을 읽어 컨텍스트에 넣는다 |
| **reserve** | LLM 출력의 다음 예약 필드 |
| **origin** | 흐름이 어느 예약에서 열렸는가 |
| **시스템 작업** | 사용자 접점이 없는 호출 — 플랜, 정리, 압축, 만료 검사 |
| **블랙아웃** | LLM 트리거가 금지되는 시간대. 플랜과 만료 검사가 이 진입 시각에 돈다 |
| **INDEX** | `memory/*.md`의 `description` frontmatter에서 생성되는 목록. 매 턴 컨텍스트에 들어간다 |
| **인바운드** | 사용자가 흐름 밖에서 보내는 메시지. 응답이 보장되지 않는다 |
| **플랜** | 블랙아웃에 그리는 하루 계획. `plan_items` 테이블 |
| **비동기 풀** | 마감이 있는 작업 목록. `pool_items` 테이블 |
| **압축** | 현재 흐름 대화가 임계를 넘으면 오래된 부분을 요약으로 대체하는 것 |
| **deferred** | 발화했으나 처리하지 못한 예약. `state='fired'` |
| **`DATA_DIR`** | 설정·프롬프트·기억 파일·DB가 사는 디렉터리. 볼륨으로 마운트된다 |
| **`TurnTx`** | 한 턴의 도구 쓰기 효과를 모으는 트랜잭션. 최종 JSON 성공 시 commit |
| **`MemoryTx`** | 정리 호출의 기억 쓰기를 모으는 트랜잭션 |

---

## 2. 전체 구조

```
텔레그램 (롱폴링)
    │
    ▼
receive_handler ─ 유효성 판정 · DB 기록 ─▶ 디바운스 버퍼
    │                                       │ (만료)
    └ command_handler ─ 즉시 실행           ▼
flow_timer (MIN reservations.at WHERE state='scheduled') ─▶ event_queue ─▶ worker ─▶ turn_executor / plan_runner / cleanup_runner
system_timer (다음 블랙아웃) ──────────────────────────▶
cleanup 강등 ─────────────────────────────────────────▶
```

**참조 구현 스택**: Node 24 + TypeScript(타입 제거 실행), SQLite(`node:sqlite`), grammY(텔레그램), openai SDK 호환 클라이언트, luxon(시간대), zod(검증). 다른 스택이면 타입만 바꾼다. 프롬프트 파일과 기억 파일은 `DATA_DIR` 볼륨에 둔다.

**디렉터리**

```
DATA_DIR/
├── config
├── prompts/
│   ├── persona.md          # (선택) 항상 로드
│   ├── call-rules.md       # (필수) 항상 로드
│   ├── plan-rules.md       # (플랜 사용 시 필수)
│   ├── cleanup-rules.md    # (정리 사용 시 필수)
│   ├── compact-rules.md    # (압축 사용 시 필수)
│   └── jobs/
│       └── *.md            # 예약 행의 prompt가 가리키는 파일
├── memory/
│   ├── state.md            # (선택) 항상 로드
│   └── *.md                # INDEX로 노출, memory_read로 연다
└── aigan.db
```

---

## 3. 상태와 모드

`harness_state`는 행 1개다.

| 필드 | 값 | 의미 |
|---|---|---|
| `mode` | `active` / `paused` | 시스템 작동 여부. `/pause`·`/resume`이 바꾼다 |
| `current_flow_id` | INTEGER / NULL | 열려 있는 흐름. NULL이면 흐름 사이 |
| `random_due` | INTEGER | 랜덤 이벤트 대기 수 |
| `last_roll_at` | TEXT | 마지막 주사위 시각 |
| `last_plan_date` | TEXT | 마지막 플랜의 로컬 날짜 |
| `failure_count` | INTEGER | 연속 실패 |
| `pause_reason` | NULL / `balance` / `daily_limit` | 자동 보류 사유 |
| `daily_calls` | INTEGER | 오늘 LLM 요청 수 |
| `daily_calls_date` | TEXT | 카운트 기준 로컬 날짜 |
| `turn_generation` | INTEGER | 턴 세대 카운터. `/cancel` 시 증가 |
| `pending_system_event` | INTEGER | 0/1. 흐름 중 블랙아웃 진입이 발생했음을 표시 |

`mode`는 `active/paused` 둘. "흐름 사이"는 `current_flow_id IS NULL`.

**`random_due`의 발생과 감소**
- 발생: 단위 시간(`random.unit_sec`)마다 확률 `random.prob`로 1 증가, `random.max_due` 상한. 블랙아웃에도 증가. `last_roll_at`이 마지막 시행 시각.
- 감소: **`reserve.consume_random = true`인 흐름의 첫 턴 성공 직후** 1 감소. 발화 시점이 아니다(부록 B). `consume_random`이 없거나 false면 감소하지 않는다.

**`daily_calls`** — 로컬 자정 리셋. LLM API 요청 1건마다 1 증가(도구 라운드 포함).

**파생 상태**

| 이름 | 조건 |
|---|---|
| 정지 | `mode=paused` |
| 흐름 없음 | `mode=active` and `current_flow_id IS NULL` |
| 흐름 있음 | `current_flow_id IS NOT NULL` |

---

## 4. 이벤트 처리 표

큐 이벤트는 넷: `debounce_expiry`, `reservation_due(id)`, `system_event`, `cleanup_demotion(flow_id)`.

| 이벤트 | 정지 | 흐름 없음 | 흐름 있음 |
|---|---|---|---|
| `debounce_expiry` | 버퍼 비움 | 대기 인바운드가 있고 인바운드 예약이 없으면 → 인바운드 예약 생성(`at=now`, 블랙아웃 밖으로 보정). 아니면 무시 | 버퍼가 비어 있지 않으면 → 턴 트리거. 비어 있으면 무시 |
| `reservation_due(id)` | 무시(예약 보존) | 예약 소비, 새 흐름 개시 | **id == `current_flow.pending_self_reservation_id`** → 소비, 턴 트리거. **아니면** `state='fired'` 유지(deferred). 흐름 종료 시 처리 |
| `system_event` | 무시 | 만료 검사 → 플랜 | **`pending_system_event=1` 설정 후 종료**(재큐 없음). 흐름 종료 시 처리 |
| `cleanup_demotion(flow_id)` | 무시 | `cleanup_runner` 재실행 | 재큐하지 않음. `cleanup_status='pending'`이면 다음 흐름 종료 시 처리(방어) |

self-reserve 판정은 id 기반(부록 B).

**deferred 처리 순서**
- 흐름이 닫히면 `reservations WHERE state='fired' ORDER BY at ASC, id ASC LIMIT 1`을 조회해 가장 이른 것을 처리.
- 처리 방식은 `reservation_due`와 동일. 하나 처리하면 그 흐름이 열리고, 나머지는 그 흐름이 닫힌 뒤 다시 조회.
- deferred가 모두 소진된 뒤에 `pending_system_event`를 확인.

**`/pause` 중에는 deferred를 처리하지 않는다.** `fired`는 그대로 두고 `/resume`에서 처리.

---

## 5. 상태 전이

### 5.1 예약 (`reservations`)

| 컬럼 | 타입 | 비고 |
|---|---|---|
| `id` | INTEGER PK | 낡음 판정용. 교체 시 새 id |
| `at` | TEXT | ISO 8601 + offset |
| `slot` | TEXT | `main` / `inbound` / `deadline`. 슬롯별로 독립 |
| `prompt` | TEXT | 프롬프트 파일 경로(`prompts/jobs/xxx.md`). 하네스는 내용을 모른다 |
| `state` | TEXT | `scheduled` / `fired`. `scheduled`만 타이머가 조준 |
| `memo` | TEXT / NULL | 다음 호출에 남기는 한 줄 |
| `payload` | TEXT / NULL | `slot='deadline'`이면 `{"pool_id":N}`, 그 외 NULL |
| `created_at` | TEXT | |

| 전이 | 조건 |
|---|---|
| 생성 | LLM `reserve`, `pool_create`(slot=deadline), 인바운드 도착(no-flow, slot=inbound). `state='scheduled'` |
| 발화 | 타이머 → `state='fired'`, `reservation_due(id)` 큐 투입 |
| 소비 | 흐름 개시 또는 self-reserve 턴. 행 삭제 |
| 보류 | 발화했으나 처리 못 함. `state='fired'` 유지(deferred) |
| 교체 | 디바운스 턴 트리거 시 `pending_self_reservation_id` 행 삭제 후 새 예약 |
| 삭제 | 흐름 종료 시 `pending_self_reservation_id` 행 삭제. `end`의 `reserve`는 다음 흐름 개시용으로만 생성되고 pending에 넣지 않는다 |

**클램프 규칙 (생성 시)**

| 원천 | `at` 규칙 |
|---|---|
| LLM `reserve` | `clamp(now+min_lead, now+max_lead)`, 블랙아웃이면 그 끝으로 |
| `pool_create` | `deadline` 그대로. 과거면 `now+min_lead`, `now+pool_ttl` 초과면 거부. 블랙아웃이면 그 끝으로 |
| 인바운드 도착 | `now`. 블랙아웃 밖으로 보정 |

**생성 시 prompt 결정**
- LLM `reserve`: `reserve.prompt`.
- `pool_create`: 그 도구 호출의 `prompt` 인자(§7.2).
- 인바운드 도착: config의 `inbound_prompt`.

### 5.2 흐름 (`flows`)

| 컬럼 | 타입 | 비고 |
|---|---|---|
| `id` | INTEGER PK | |
| `origin_slot` | TEXT | 이 흐름의 `reserve`가 만드는 행의 slot |
| `origin_reservation_id` | INTEGER | 삭제된 행을 가리켜도 무해. 기록용 |
| `pending_self_reservation_id` | INTEGER / NULL | 이 흐름의 다음 턴 예약 id |
| `prompt` | TEXT | 이 흐름이 사용한 프롬프트 파일 경로 |
| `started_at` | TEXT | |
| `ended_at` | TEXT / NULL | |
| `end_reason` | TEXT / NULL | agent / paused / cancelled |
| `cleanup_status` | TEXT | pending / done / failed / skipped |
| `summary` | TEXT / NULL | 압축된 대화 요약 |
| `compacted_until_id` | INTEGER / NULL | 압축이 커버한 마지막 message id |

| 전이 | 조건 |
|---|---|
| 열림 | 예약 소비 → `current_flow_id` 설정, origin·prompt 기록 |
| 턴 | self-reserve 또는 디바운스. `pending_self_reservation_id` 갱신 |
| 압축 | 응답 전송 뒤 문자 임계 초과 시 `summary`·`compacted_until_id` 갱신 |
| 닫힘 | LLM `flow=end`, 또는 `/pause`, `/cancel` → `ended_at`, `end_reason`, `cleanup_status=pending` → 정리 동기 실행 |
| 정리 완료 | `cleanup_status=done` |

### 5.3 비동기 풀 (`pool_items`)

| 컬럼 | 타입 | 비고 |
|---|---|---|
| `id` | INTEGER PK | |
| `task` | TEXT | |
| `deadline` | TEXT | |
| `prompt` | TEXT | 마감 흐름이 사용할 프롬프트 파일 경로 |
| `state` | TEXT | pending / due / judged |
| `close_reason` | TEXT / NULL | judged / reissued / expired / cancelled |
| `created_at` | TEXT | |
| `due_at` | TEXT / NULL | |

| 전이 | 조건 |
|---|---|
| `pending` | `pool_create` |
| `due` | deadline 예약 발화. `due_at=now` |
| `judged` | `pool_judge(judged)`, `expired`, `reissued`, `cancelled` |
| `due_keep` | `pool_judge(due_keep)` → `due` 유지 |

**판정 시 해당 `pool_id`의 deadline 예약(`scheduled`·`fired`)을 삭제한다**(부록 B).

### 5.4 인바운드 (`inbound_messages`)

`id`, `content`, `received_at`, `status`(pending/consumed/expired), `consumed_at`, `consumed_flow_id`.

| 전이 | 조건 |
|---|---|
| `pending` | 수신(흐름 없음, 블랙아웃 아님) |
| `consumed` | 인바운드 흐름 개시 시 전부 소비 표시. `consumed_flow_id` 기록 |
| `expired` | 만료 검사(시간 초과 또는 N건 초과 시 오래된 것부터) |

### 5.5 플랜 (`plan_items`)

`id`, `text`, `hint`(NULL), `done`(0/1), `created_at`, `plan_date`.

| 전이 | 조건 |
|---|---|
| 생성·교체 | 플랜 호출의 `items` 출력으로 전체 교체. 새 `plan_date`면 이전 날짜 행 전체 삭제 |
| 체크 | `plan_done(id)` |
| 추가 | `plan_add(text, hint?)` |

### 5.6 메시지 (`messages`)

`id`, `flow_id`, `role`(user/assistant), `content`, `ts`, `ignored`(0/1), `ignored_reason`(ended/paused/blackout/late).

**이벤트 블록은 `messages`에 저장하지 않는다.** 컨텍스트 조립 시 마지막 user 메시지에 합쳐지고, 저장되지 않는다. 그래서 `role='event'`는 쓰지 않는다(부록 B).

### 5.7 LLM 호출 로그 (`llm_calls`)

`id`, `kind`(turn/cleanup/plan/compact), `flow_id`(NULL 허용), `request`, `response`, `input_tokens`, `cached_tokens`, `output_tokens`, `latency_ms`, `success`, `created_at`. 인덱스: `created_at`, `kind`.

---

## 6. 컨텍스트 조립과 콘텐츠 계약

### 6.1 턴 호출 조립 (7개 블록)

| # | role | 내용 | 출처 |
|---|---|---|---|
| 1 | system | persona | `prompts/persona.md` (있으면 매 호출) |
| 2 | system | call-rules | `prompts/call-rules.md` (필수, 플레이스홀더 치환) |
| 3 | system | state | `memory/state.md` (있으면 매 호출) |
| 4 | system | INDEX | `memory/*.md` frontmatter에서 생성 |
| 5 | system | job prompt | 예약 행의 `prompt`가 가리키는 파일 |
| 6 | user/assistant | 현재 흐름 대화 | `messages WHERE flow_id=? AND ignored=0 AND (compacted_until_id IS NULL OR id > compacted_until_id)`. `flows.summary`가 있으면 앞에 요약 블록. assistant는 JSON 원문 |
| 7 | user | 이벤트 블록 | 하네스 |

- 6번의 마지막 user 메시지와 7번은 하나의 user 메시지로 합친다.
- 사진·파일은 내용을 버리고 `[사진]`/`[파일]` 표시만 남긴다.

### 6.2 콘텐츠 계약 — 하네스가 프롬프트에 요구하는 것

**파일 목록과 로드 조건**

| 파일 | 필수 | 로드 시점 | 없으면 |
|---|---|---|---|
| `prompts/persona.md` | 선택 | 매 턴 | 건너뜀 |
| `prompts/call-rules.md` | **필수** | 매 턴 | 시작 실패 |
| `prompts/plan-rules.md` | 플랜 사용 시 필수 | 플랜 호출 | 플랜 비활성 |
| `prompts/cleanup-rules.md` | 정리 사용 시 필수 | 정리 호출 | 정리 skip(`cleanup_status=skipped`) |
| `prompts/compact-rules.md` | 압축 사용 시 필수 | 압축 호출 | 압축 비활성 |
| `prompts/jobs/*.md` | 최소 1개 | 예약 행의 `prompt` | 그 예약 폐기, 로그 |
| `memory/state.md` | 선택 | 매 턴 | 건너뜀 |
| `memory/*.md` | 선택 | INDEX만, 본문은 `memory_read` | INDEX 생략 |

**하네스가 주입하는 플레이스홀더** — `call-rules.md`와 `plan-rules.md` 등에서 쓴다.

| 플레이스홀더 | 값 |
|---|---|
| `{now}` | 현재 ISO8601 |
| `{timezone}` | 설정의 IANA 이름 |
| `{blackout_start}` / `{blackout_end}` | 오늘의 블랙아웃 시작/끝 |
| `{min_lead_sec}` / `{max_lead_sec}` | 예약 클램프 범위 |
| `{plan_max_items}` | 플랜 항목 상한 |
| `{pool_max_pending}` | 풀 상한 |
| `{today}` | 로컬 날짜(YYYY-MM-DD) |

치환은 단순 문자열 교체다. 알 수 없는 플레이스홀더는 그대로 둔다.

**이벤트 블록 렌더링** — 하네스가 고정 형식으로 만든다.

```
[event]
now: <ISO8601>
prompt: <예약 행의 prompt 경로>
memo: <reserve.memo 또는 (없음)>
random_due: <int>
inbound_pending: <int>
pool:
  - #<id> <state> "<task>" (<deadline>, <상대시간>)
  … 외 <N>건
  (없으면 줄 생략)
plan:
  [ ] <text> — <hint>
  [x] <text> — <hint>
  (없으면 "plan: (없음)")
```

- `inbound_pending`: `inbound_messages WHERE status='pending'` COUNT.
- `pool`: `pool_items WHERE state IN ('pending','due')` 중 최대 5개. `due` 먼저(`deadline` 오름차순), 그다음 `pending`(`deadline` 오름차순). 나머지는 `… 외 N건`.
- `slot='deadline'`이면 해당 풀 항목 전문을 `pool` 위에 별도 줄로 넣는다(5개 상한 미포함).

### 6.3 시스템 작업 조립

| 호출 | 블록 |
|---|---|
| 플랜 | `plan-rules.md` + INDEX + 이벤트 블록(블랙아웃 진입, 오늘 날짜, 어제 미완 요약) |
| 정리 | `cleanup-rules.md` + INDEX + `state.md` + (`flows.summary` + `id > compacted_until_id`인 메시지) |
| 압축 | `compact-rules.md` + 압축 대상 구간 |

persona·call-rules·state는 정리·압축에 넣지 않는다.

### 6.4 INDEX 생성

`memory/*.md` 중 `description` frontmatter를 가진 파일을 파일명 사전순으로 나열. `state.md`는 제외. `description`이 없으면 파일명만. `memory_create`로 추가한 파일도 포함(`memory_max_files` 상한 내).

---

## 7. LLM 입출력 계약

### 7.1 출력 스키마

턴:

```json
{
  "messages": ["string"],
  "flow": "continue | end",
  "reserve": {"at": "<ISO8601>", "prompt": "<경로>", "memo": "string"} | null,
  "consume_random": true | false
}
```

- `messages`: 0개 이상.
- `flow=continue`면 `reserve` 필수. `flow=end`면 선택.
- `reserve.prompt`는 `prompts/jobs/` 아래 파일 경로. 없거나 읽을 수 없으면 그 예약만 폐기.
- `consume_random`: 선택, 기본 false. true면 이 흐름의 첫 턴 성공 직후 `random_due` 1 감소.

플랜:

```json
{
  "items": [{"text": "string", "hint": "string | null"}],
  "reserve": {"at": "<ISO8601>", "prompt": "<경로>", "memo": "string"} | null
}
```

정리: `{"done": true}`. 압축: `{"summary": "string"}`. `response_format: json_object`를 켠다.

### 7.2 도구 스키마

| 도구 | 인자 | 노출 |
|---|---|---|
| `memory_read` | `name: string` | 턴, 플랜, 정리, 압축 |
| `memory_write` | `name: string`, `content: string` | 정리 |
| `memory_create` | `name: string`, `description: string`, `content: string` | 정리 |
| `pool_judge` | `id: integer`, `verdict: "judged" \| "due_keep"` | 턴 |
| `pool_create` | `task: string`, `deadline: string`, `prompt: string`, `replaces?: integer` | 턴 |
| `plan_done` | `id: integer` | 턴 |
| `plan_add` | `text: string`, `hint?: string` | 턴 |

플랜 호출은 도구를 쓰지 않는다—출력의 `items`가 곧 플랜이다. 도구 목록은 호출 종류별로 분리 제공. 목록에 없는 도구를 지어내 호출하면 거부 결과를 돌려준다.

**도구 검증**
- `pool_judge`: 없는 id·이미 `judged`면 거부 결과. `pending`/`due`면 판정 + deadline 예약 삭제.
- `pool_create`: `prompt`가 `prompts/jobs/` 하위가 아니거나 파일이 없으면 거부. `replaces=N`이 없거나 이미 `judged`면 거부. `pending`/`due`면 `reissued`.
- `plan_done(id)`: 없는 id면 거부.
- `plan_add`: `plan_date` 항목 수가 `plan_max_items` 초과면 거부.
- `memory_create`: `memory_max_files` 초과면 거부.
- `memory_write`: `memory_file_max_chars` 초과면 거부.
- `memory_read`: `name`이 `memory/` 하위가 아니면 거부.

### 7.3 파싱과 재시도

| 상황 | 처리 |
|---|---|
| JSON 파싱 실패 / 스키마 검증 실패 | 1회 재시도 |
| `reserve` 누락(continue) / `at` 형식 오류 | 파싱 실패와 동일 |
| `reserve.prompt` 파일 없음/불가 | 그 예약만 폐기, 흐름 유지, 로그 |
| `at` 과거/범위 밖 | 클램프(§5.1) |
| 재시도도 실패 | 응답 통째 폐기. `failure_count++`, 백오프 예약, `flow` 유지. `alert_after` 도달 시 운영자 알림 |

실패한 응답은 `messages`도 전송하지 않는다.

### 7.4 도구 라운드와 강제 JSON

- 도구 호출·결과 전달을 최대 `max_tool_rounds`(정리·플랜·압축은 별도 상한)회 반복 후 최종 JSON.
- 상한 초과 시 `tools` 유지 + `tool_choice: "none"`으로 한 번 더 호출.
- 도구 쓰기 효과는 `TurnTx`/`MemoryTx`에 모았다가 최종 JSON 성공 시 일괄 commit.

---

## 8. 예약과 타이머

**flow_timer**: `MIN(reservations.at) WHERE state='scheduled'` 조준. 삽입·삭제·갱신 시 재조준. 발화 시 `state='fired'` + `reservation_due(id)` 큐 투입.

**system_timer**: `now` 이후 첫 블랙아웃 진입 시각 조준. 발화 시 `system_event` 큐 투입. `last_plan_date`가 오늘이면 다음 날로 건너뛴다.

**불변식**: `mode=active`이면 `reservations`에 `state='scheduled'` 행이 최소 1개이거나 `system_timer`가 살아 있다. `fired`는 불변식에 포함되지 않는다.

**블랙아웃 보정**: 예약 `at`이 블랙아웃이면 그 끝으로 민다. 발화 시점에 다시 확인. 설정에서 블랙아웃이 비면 시작 검증에서 실패시킨다.

**DST·자정 넘김**: "그날 첫 진입"은 로컬 날짜 변경으로 판정(luxon `toISODate()`). 블랙아웃이 자정을 넘어도 진입은 하루 한 번.

---

## 9. 워커 처리 상세

```
loop:
  event = queue.pop()
  if mode == paused: continue
  switch event.type:
    case debounce_expiry: handle_debounce()
    case reservation_due: handle_reservation(event.id)
    case system_event:   handle_system()
    case cleanup_demotion: handle_cleanup(event.flow_id)
```

**handle_debounce**
- 흐름 없음: 대기 인바운드 有 & 인바운드 예약 無 → 인바운드 예약 생성. 아니면 무시.
- 흐름 있음: 버퍼 비었으면 무시. 아니면 `run_turn(buffered)`.

**handle_reservation(id)**
- 행 조회. 없으면 폐기.
- 흐름 없음: 소비 → `open_flow(id)` → `run_turn(self)`.
- 흐름 있음 & id == pending_self: 소비 → `run_turn(self)`.
- 흐름 있음 & 그 외: `state='fired'` 유지(deferred).

**handle_system**
- 흐름 있음: `pending_system_event=1`, 종료.
- 흐름 없음: 만료 검사(인바운드·풀) → 플랜 실행.

**handle_cleanup(flow_id)** — `cleanup_status='done'`이면 무시. 아니면 재실행.

**run_turn(trigger)**
1. `balance_guard`(§9.1). 초과 시 `pause_reason` 설정, 이벤트 재큐, 종료.
2. (디바운스 트리거면) pending self 예약 삭제, `pending_self_reservation_id` NULL.
3. 컨텍스트 조립 → `turn_executor` → 파싱. **`turn_generation`을 시작 시 읽고 파싱 직후 비교.** 다르면 `TurnTx` rollback, 폐기, 로그(부록 B).
4. `result_applier`:
   a. `TurnTx` commit.
   b. `messages` 전송(취소·억제 플래그 없으면).
   c. `reserve` 반영. `continue`면 self 예약 + pending 갱신. `end`면 다음 흐름 개시 예약만 생성, pending NULL.
   d. `flow=end`면 흐름 닫고 `cleanup_runner` 동기 호출. 실패 시 `cleanup_demotion` 큐 강등.
5. `consume_random=true`면 `random_due` 1 감소.
6. 압축 검사(§13.2). 응답 전송 뒤.
7. 실패: 폐기, `failure_count++`, 백오프, 흐름 유지.

**흐름 종료 후 공통 마무리 (deferred + system_event)**

흐름이 닫히는 모든 경로—정상 종료, `/cancel`, 재시작 복구—에서 순서대로. `/pause`는 예외.

1. `reservations WHERE state='fired' ORDER BY at ASC, id ASC LIMIT 1`. 있으면 소비 후 새 흐름. 그 흐름이 닫히면 다시 1.
2. 없으면 `pending_system_event=1` 확인. 1이면 리셋 후 만료 검사 → 플랜.
3. 둘 다 없으면 다음 큐 이벤트.

### 9.1 `balance_guard`

- **provider** (`openai` | `deepseek`): `openai`는 잔액 확인 안 함. `deepseek`는 `/user/balance` 호출, 응답 `currency` 로그, `balance_threshold`와 비교(계정 통화). 통화 불일치 시 경고 후 비교.
- 잔액 부족: `pause_reason='balance'`, 이벤트 재큐, `balance_retry_sec` 뒤 재확인.
- 일일 상한: `daily_calls >= daily_call_limit`이면 `pause_reason='daily_limit'`, 다음 로컬 자정까지 보류.
- 보류 중 도착 메시지는 버퍼/인바운드에 쌓였다가 재개 시 처리. `/resume` 시 `pause_reason=NULL`.

### 9.2 운영 명령 상태 전이

| 명령 | 정지 | 흐름 없음 | 흐름 있음 |
|---|---|---|---|
| `/pause` | 확인, 무시 | `mode=paused`, 타이머 정지 | 흐름 닫기(`paused`), 정리 실행, 버퍼 `late`, `mode=paused`. deferred 미처리 |
| `/resume` | `mode=active`, `pause_reason=NULL`. **deferred 먼저**, 그다음 `MIN(scheduled)` 재조정. `last_plan_date` 미완이면 `system_event`(블랙아웃 중이면 끝으로) | 무시 | 무시 |
| `/cancel` | 무시 | 무시 | `turn_generation++`, 흐름 닫기(`cancelled`), 정리 skip(`skipped`), 버퍼 `late`, pending self 삭제, **deferred 처리**, 그다음 `MIN(scheduled)` 교체, 최근 봇 메시지 삭제 시도 |

**403(차단)**: `messages` 전송 중 403이면 남은 전송 중단, `/pause`와 동일 처리. 이미 보낸 것은 유지.

---

## 10. 인바운드 처리

**수신(흐름 없음, 블랙아웃 아님)**: `inbound_messages`에 `pending` 저장 + 디바운스 타이머 (재)설정.

**수신(블랙아웃 중)**: `messages`에 `ignored=1, ignored_reason='blackout'` 저장. 인바운드로 만들지 않고 버퍼에도 넣지 않는다(§16).

**디바운스 만료(흐름 없음)**: `pending` 인바운드가 있고 인바운드 예약이 없으면 예약 생성(`at=now`, 블랙아웃 보정, **`prompt`는 config의 `inbound_prompt`**). 발화 시 그 시점의 모든 `pending`을 `consumed`로 표시(`consumed_flow_id`)하고 컨텍스트에 넣는다. 다루지 않은 것도 소비된 채로 남는다.

**흐름 종료 시**: 대기 인바운드가 남아 있고 인바운드 예약이 없으면 새 예약 생성.

**만료(블랙아웃 진입 시)**: `received_at`이 `inbound_ttl` 초과이거나 `pending`이 `inbound_max` 초과면 오래된 것부터 `expired`. `expired`는 컨텍스트에 편입되지 않는다.

---

## 11. 비동기 풀

**생성**: `pool_create(task, deadline, prompt)` → `pool_items` `pending`(prompt 포함) + `reservations`(`slot=deadline, prompt=그 값, payload={pool_id}`).

**마감 발화**: deadline 예약 소비 → 풀 `due` → 마감 흐름 개시(예약의 `prompt`). 흐름 종료 시 `reserve`가 있으면 새 deadline 예약.

**판정**: `pool_judge(judged)` → `judged`+사유. `due_keep` → `due` 유지. 판정 시 deadline 예약 삭제.

**재발행**: `pool_create(replaces=원본)` → 원본 `reissued`, 원본 deadline 예약 삭제, 신규 `pending`.

**만료(블랙아웃 진입 시)**: `created_at`이 `pool_ttl` 초과이거나 `pending+due`가 `pool_max` 초과면 오래된 것부터 `expired`. deadline 예약 삭제.

**판정 위치**: `pool_judge`는 턴 도구이므로 어느 흐름에서든 가능.

---

## 12. 데일리 플랜

**발화**: `system_timer` → 블랙아웃 진입 → `handle_system` → (deferred·system_event 마무리 뒤) 만료 검사 → `plan_runner`.

**입력**: `plan-rules.md`, INDEX, 이벤트 블록(날짜, 어제 미완 요약).

**출력**: `{"items": [...], "reserve": {...}|null}`. 도구 없음.

**반영**: 새 `plan_date`로 기존 행 삭제 후 삽입. `items`가 `plan_max_items` 초과면 앞에서부터 자른다. `reserve`가 있으면 첫 예약 생성.

**턴 중 조작**: `plan_done`, `plan_add`는 `TurnTx`에 모여 턴 성공 시 반영.

**하루 경계**: `last_plan_date`가 오늘이면 `system_timer`가 다음 날로 건너뛴다.

---

## 13. 정리 호출과 압축

### 13.1 정리

**발화**: 흐름 닫힘 직후 `run_turn` 4-d에서 동기. 실패 시 `cleanup_demotion` 큐 강등.

**입력**: `cleanup-rules.md`, INDEX, `state.md`, **압축된 흐름**(`flows.summary` + `id > compacted_until_id`인 메시지).

**도구**: `memory_read/write/create`. `MemoryTx` commit.

**출력**: `{"done": true}`. 성공 시 `cleanup_status=done`. 실패면 `pending` 유지.

**강등**: `cleanup_demotion(flow_id)`를 백오프로 큐에. `done`이면 무시.

**`state.md` 갱신**: 정리 commit의 일부(같은 트랜잭션).

### 13.2 압축

**발화**: `run_turn` 6단계. 비압축 구간(`id > compacted_until_id`)의 `content` 문자 수 합이 `flow_compact_chars` 초과 시.

**얼마나**: 가장 오래된 메시지부터, 남은 구간이 `flow_compact_chars / 2` 이하가 될 때까지. 최소 1개.

**입력**: `compact-rules.md`, 압축 대상 구간, 기존 `summary`.

**출력**: `{"summary": "..."}`. 도구 없음.

**반영**: `summary` 갱신, `compacted_until_id`를 대상의 마지막 `messages.id`로. 실패 시 로그만, 다음 턴 재시도.

---

## 14. 메모리 파일 메커니즘

하네스는 기억 파일의 **내용을 해석하지 않는다.** 파일 슬롯과 로드 규칙만 안다.

| 파일 | 로드 | INDEX |
|---|---|---|
| `memory/state.md` | 매 턴 통째로 | 제외(frontmatter 없음) |
| `memory/*.md` (그 외) | INDEX만. 본문은 `memory_read` | 포함(`description` frontmatter) |

- `memory_write`는 파일 전체 교체. `memory_file_max_chars` 초과면 거부.
- `memory_create`는 새 파일 + `description`. `memory_max_files` 초과면 거부.
- 정리 호출만 쓰기 가능. 턴·플랜·압축은 읽기만.
- 섹션 구조와 의미는 전적으로 `cleanup-rules.md`(운영자 소유)가 규정한다.

**경로 검증**: `memory_read(name)`과 `memory_write/create(name)`은 `memory/` 하위로 정규화하고, `..` 등으로 벗어나면 거부한다. `reserve.prompt`와 `pool_create(prompt)`도 `prompts/jobs/` 하위로 검증한다.

---

## 15. 재시작 복구

1. `harness_state` 읽기. `paused`면 타이머만 끄고 종료.
2. `cleanup_status=pending`인 닫힌 흐름 → `cleanup_demotion` 큐(백오프 0).
3. 열린 흐름이 있으면: 마지막 assistant 응답 뒤 유효 user 메시지로 디바운스 버퍼 복원. 블랙아웃 아니면 만료 즉시, 블랙아웃이면 끝 시각.
4. `scheduled` 예약: `at` 과거면 즉시 발화(블랙아웃이면 밀기), 미래면 타이머 재조정.
5. `pause_reason` 있으면 재확인 타이머.
6. `fired`(deferred)가 있고 흐름이 복원되지 않았으면 deferred 처리.
7. `pending_system_event=1`이고 흐름 없으면 만료 검사 → 플랜.
8. `last_plan_date` 미완이면 `pending_system_event=1` 설정(블랙아웃 중이면 끝에 처리).

진행 중 LLM 호출은 사라진다. 그 턴의 `messages`는 커밋 안 됐으므로 사용자는 못 받았고, 다음 턴에 재시도된다.

---

## 16. 텔레그램 운영

- **chat_id 제한**: 설정 외 메시지는 로그 없이 버림.
- **블랙아웃 검사**: 수신 즉시 확인. 블랙아웃 중이면 `ignored_reason='blackout'` 저장, 버퍼·인바운드로 보내지 않음.
- **평문 전송**: `parse_mode` 미사용.
- **길이**: 4096자 초과는 줄바꿈 경계 분할.
- **다중 messages**: `send_interval` 간격. 429는 `retry_after` 대기 후 재전송.
- **403**: 남은 전송 중단, `/pause` 처리.
- **그 외 오류**: 몇 회 재시도 후 로그만, 스케줄 적용은 진행.
- **운영 명령**: `/pause`, `/resume`, `/cancel`은 즉시 처리(큐 미경유). §9.2.

---

## 17. 확장 지점

이 하네스를 다른 용도로 쓸 때 손대는 곳.

### 17.1 새 트리거 추가

트리거는 구조적이다: `reservation_due`, `debounce_expiry`, `system_event`, `cleanup_demotion`. 새 종류를 추가하려면 이벤트 큐와 워커 `switch`에 분기를 넣는다. 대부분은 **예약 행으로 표현**되므로 코드 변경 없이 가능하다—`reserve.prompt`에 새 job 파일을 지정하면 된다.

### 17.2 새 프롬프트 파일 추가

1. `prompts/jobs/`에 파일을 쓴다.
2. `reserve`나 `pool_create`에서 그 경로를 지정한다.
3. 코드 변경 없음.

### 17.3 새 도구 추가

1. `tools.ts`에 스키마와 실행기를 넣는다.
2. 호출 종류별 도구 목록에 추가한다.
3. 결과 적용 규칙(즉시 vs `TurnTx`)을 정한다.

### 17.4 새 슬롯 추가

`slot`은 네임스페이스다. `main`/`inbound`/`deadline` 외에 새 슬롯이 필요하면 `slot` 허용값에 추가하고, 그 슬롯의 예약을 만드는 경로를 정의한다. 슬롯 간 독립성은 자동으로 유지된다.

### 17.5 새 시스템 작업 추가

플랜·정리·압축처럼 사용자 접점 없는 호출을 추가하려면: 프롬프트 파일 + 실행기 + 이벤트 종류(또는 `system_timer` 분기). `turn_executor`를 공유한다.

### 17.6 FE 교체

텔레그램 어댑터만 교체하면 된다(Slack, Discord, 웹소켓). `receive_handler`·`command_handler`의 인터페이스는 FE 중립이다.

### 17.7 예시 부트스트랩

하네스를 처음 받았을 때 돌려보려면 최소 세트가 필요하다.

- `prompts/call-rules.md` — 출력 스키마, 도구 목록, 이벤트 블록 읽는 법, `reserve` 규칙
- `prompts/jobs/generic.md` — "사용자에게 지금 필요한 것을 물어보고 돕는다"
- `prompts/jobs/inbound.md` — "사용자의 메시지에 응답한다" (config `inbound_prompt` 기본값)
- `prompts/plan-rules.md` — "오늘 사용자에게 물어볼 것 세 가지를 정하라"
- `prompts/cleanup-rules.md` — "이번 흐름에서 배운 것을 `memory/*.md`에 기록하라"
- `memory/state.md` — 빈 템플릿

이 세트로 "매일 세 번 안부를 묻는 비서"가 돌아간다. 여기서 운영자가 자기 파일로 교체한다.

---

## 부록 A — 설정

단일 파일(`DATA_DIR/config`), 시작 시 로드(zod 검증). 변경은 재시작.

| 키 | 기본 | 의미 |
|---|---|---|
| `timezone` | `Asia/Seoul` | IANA |
| `blackout` | `00:00-08:00` | 불가 시간대. 자정 넘김 허용. 빈 값 금지 |
| `inbound_prompt` | `prompts/jobs/inbound.md` | 인바운드 예약의 prompt |
| `message_debounce_sec` | 20 | |
| `reservation_lead_min_sec` | 60 | |
| `reservation_lead_max_sec` | 10800 | |
| `inbound_max_pending` | 10 | |
| `inbound_ttl_sec` | 86400 | |
| `pool_max_pending` | 10 | |
| `pool_ttl_sec` | 172800 | |
| `plan_max_items` | 3 | |
| `random_unit_sec`, `random_prob`, `random_max_due` | 3600 / 0.15 / 3 | `random_due` 발생 |
| `failure_backoff_first_sec` | 600 | |
| `failure_backoff_cap_sec` | 7200 | |
| `failure_alert_after` | 3 | |
| `max_tool_rounds` | 3 | 턴 |
| `max_cleanup_tool_rounds` | 5 | 정리 |
| `max_plan_tool_rounds` | 2 | 플랜 |
| `max_compact_tool_rounds` | 1 | 압축 |
| `provider` | — | `openai` / `deepseek` |
| `model`, `api_key` | — | |
| `bot_token`, `owner_chat_id` | — | |
| `daily_call_limit` | — | 비용 상한 |
| `balance_threshold`, `balance_retry_sec` | — | `deepseek`일 때만 |
| `flow_compact_chars` | 24000 | |
| `memory_file_max_chars`, `memory_max_files` | 8000 / 8 | |

---

## 부록 B — 설계 근거

| 결정 | 근거 |
|---|---|
| 파싱 실패 1회 재시도 | 일시적 오류로 턴이 유실되는 걸 막는다 |
| 강제 JSON 시 `tool_choice:none`, `tools` 유지 | 도구를 빼면 캐시가 깨져 비용이 오른다 |
| 도구 쓰기는 최종 성공 시 일괄 commit | 부분 적용되면 재시도 시 상태가 꼬인다 |
| 커밋 후 발신 | 발신 후 커밋하면 재시작 시 중복 발신이 난다 |
| 블랙아웃 빈 값 금지 | 시스템 타이머의 기준점이 사라져 플랜이 발화하지 못한다 |
| `replaces`로 원본 `reissued` | 같은 의무가 풀에 두 번 존재하면 "밀린 게 두 개"가 아니라 "한 일이 두 번"이 된다 |
| self-reserve id 기반 판정 | deadline 슬롯에 다른 예약이 섞인다 |
| `end`의 `reserve`는 다음 흐름용, pending 미등록 | "이 흐름의 다음 턴"과 "다음 흐름의 개시"는 층위가 다르다 |
| 플랜 출력은 `items`만 | 짧은 작업이라 도구 라운드가 불필요하다 |
| `reservation_due`는 id만 | 행 조회로 slot을 얻는다 |
| 정리 동기 실행 | 다음 흐름이 백지에서 시작하지 않게 한다. 실패 시에만 큐 강등 |
| `state.md` 상시 컨텍스트 | 매 턴 필요한 최소 상태를 INDEX 열람 없이 제공한다 |
| `mode`에서 `ended` 제거 | "ended"는 "흐름 없음"과 중복이다 |
| `reservations.state`(scheduled/fired) | 발화했으나 처리 못 한 예약을 타이머가 재발화하지 않게 한다. `fired`가 곧 deferred |
| `consume_random`을 LLM이 결정 | `random` 슬롯을 없앴으므로 "어느 흐름이 랜덤을 소비하는가"를 slot이 아니라 LLM의 명시적 플래그로 정한다. 첫 턴 성공 후 감소하므로 백오프 재시도로 이중 감소하지 않는다 |
| `pool_items.prompt` | 마감 흐름이 어떤 job 파일을 쓸지는 `pool_create` 시점에 정해져야 한다. 예약 발화 시점에는 풀 항목만 있고 프롬프트가 없으면 흐름을 열 수 없다 |
| `inbound_prompt` config | 인바운드 예약은 하네스가 만들므로 프롬프트 출처가 필요하다. job 파일로 두되 config로 경로를 지정한다 |
| `messages`에 `role='event'` 없음 | 이벤트 블록은 저장하지 않는다. 저장하면 다음 턴에 두 번 들어간다 |
| 압축을 별도 LLM 호출로 | 정리와 시점이 다르다. 응답 직후라 사용자 지연이 없다 |
| `/cancel`의 `turn_generation` | 진행 중 호출의 결과가 유효한지 판정해야 한다 |
| `pending_system_event` 플래그 | 큐 재투입은 흐름 중 무한 재순환으로 CPU를 태운다 |
| deferred를 "흐름 닫힘 공통 마무리"로 | 경로마다 처리하면 한 곳을 빠뜨린다. `/pause`만 예외 |
| 압축을 문자 수 기준으로 | `llm_calls.input_tokens`는 전체 컨텍스트라 흐름 대화만의 토큰이 아니다 |
| `compacted_until_id`(id 기준) | `ts`는 동시각 충돌이 난다 |
| 정리 입력을 "압축 + 남은 구간"으로 | 원본을 다 주면 압축의 비용 절감이 사라진다 |
| `pool` 요약 5개 상한 | 20개가 이벤트 블록에 들어가면 컨텍스트를 낭비한다 |
| `blackout`을 수신 시점에 기록 | 버퍼에 넣었다가 나중에 거르면 추적이 어렵다 |
| `pool_judge` 시 deadline 예약 삭제 | 판정됐는데 마감이 발화하면 유령 흐름이 열린다 |
| `provider`별 잔액 확인 | OpenAI에는 잔액 조회 API가 없다 |
| `turn_generation`을 파싱 직후에 비교 | 호출 전은 취소를 못 잡고, 커밋 후는 롤백이 늦다 |
| `messages` 전송 중 403은 중단 | 403은 차단이라 이후 전송도 실패한다 |
| `slot`+`prompt` 분리 | 하네스가 콘텐츠를 모르게 한다. slot은 네임스페이스, prompt는 파일 경로 |
| 경로 검증 | `reserve.prompt`나 `memory_read`가 `DATA_DIR` 밖을 가리키면 임의 파일 접근이 된다 |

---

## 부록 C — 테스트 케이스

| # | 상황 | 기대 |
|---|---|---|
| 1 | 설치 직후 메시지 | `mode=paused` → 무시. 안내만 |
| 2 | `/resume` | `mode=active`, 시스템 타이머 armed, 첫 플랜 |
| 3 | 블랙아웃 중 메시지 | `ignored=blackout` 저장, 버퍼·인바운드 미생성 |
| 4 | 흐름 없음 + 메시지 → 디바운스 만료 | 인바운드 예약 생성(`inbound_prompt`), 발화 시 인바운드 흐름 |
| 5 | 흐름 중 self-reserve 발화 | 턴 트리거 |
| 6 | 흐름 중 다른 slot 예약 발화 | `fired` deferred, 흐름 종료 후 처리 |
| 7 | 사용자가 self-reserve 전에 응답 | 옛 예약 삭제, 새 reserve |
| 8 | deadline 예약 + main 흐름 활성 | deferred, main 종료 후 마감 흐름 |
| 9 | `flow=end` + `reserve` 없음 | 흐름 닫힘, `system_timer` 보루 |
| 10 | 정리 실패 | `cleanup_demotion` 강등, 백오프 재시도 |
| 11 | 재시작(정리 pending) | 시작 시 재실행 |
| 12 | 재시작(디바운스 대기) | 버퍼 복원, 만료 재예약 |
| 13 | `pool_create` → 마감 발화 | `due` 전이, 마감 흐름이 `pool_items.prompt` 사용 |
| 14 | `pool_judge(judged)` | `judged`+사유, deadline 예약 삭제 |
| 15 | `pool_judge(due_keep)` | `due` 유지, retry 예약 |
| 16 | `pool_create(replaces=원본)` | 원본 `reissued`, 원본 deadline 예약 삭제, 신규 `pending` |
| 17 | 풀 상한 초과 | 오래된 것 `expired`, deadline 예약 삭제 |
| 18 | 인바운드 상한/시간 초과 | 오래된 `pending` `expired` |
| 19 | `reserve.at` 1주 뒤 | `max_lead`로 당김 |
| 20 | `reserve.at` 30초 뒤 | `min_lead`로 밀림 |
| 21 | 파싱 실패 3회 연속 | 백오프 증가, 알림 1회, 흐름 유지 |
| 22 | `/cancel` during turn | `turn_generation++`, 파싱 직후 롤백·폐기, 흐름 닫힘, 정리 skip, deferred 처리, 슬롯 교체 |
| 23 | 블랙아웃 진입 + 활성 흐름 | `pending_system_event=1`, 흐름 이어짐. 종료 후 플랜 |
| 24 | 5000자 메시지 | 분할 전송 |
| 25 | 모델이 목록 밖 도구 호출 | 거부 결과 반환, 턴 계속 |
| 26 | `flow=end` 시 `pending_self_reservation_id` | 그 행 삭제, `end`의 reserve는 새 흐름 개시용 |
| 27 | deferred 2개 + 흐름 종료 | `at` 오름차순으로 하나씩 |
| 28 | deferred + `pending_system_event` | deferred 전부 처리 후 플랜 |
| 29 | 압축 임계 초과 | `compact` 호출, `summary`·`compacted_until_id` 갱신 |
| 30 | `/pause` + 활성 흐름 | 흐름 닫힘, 정리 실행, 버퍼 `late`, deferred 미처리 |
| 31 | `/resume` + 과거 `scheduled` | deferred 먼저, 그다음 과거 예약 즉시 발화 |
| 32 | `daily_call_limit` 도달 | `pause_reason=daily_limit`, 다음 자정까지 보류 |
| 33 | `consume_random=true` | 그 흐름 첫 턴 성공 후 `random_due` 1 감소. 실패 시 미감소 |
| 34 | `system_event` + 활성 흐름 반복 | 큐 재순환 없음. 플래그만 |
| 35 | 재시작 + `fired`만 존재 | 복구 6단계에서 deferred 처리 |
| 36 | `messages` 전송 중 403 | 남은 전송 중단, `/pause` 처리 |
| 37 | 정리 입력 | `summary` + 남은 구간 |
| 38 | `pool` 20건 | 이벤트 블록에 5개 + `… 외 15건` |
| 39 | `reserve.prompt` 파일 없음 | 그 예약만 폐기, 흐름 유지, 로그 |
| 40 | 부트스트랩 세트만으로 실행 | 매일 세 번 안부를 묻는 흐름이 돈다 |
| 41 | `reserve.prompt`가 `../../etc` | 경로 검증에서 거부, 그 예약 폐기 |
| 42 | `memory_read(name="../../x")` | 거부 결과 반환 |
