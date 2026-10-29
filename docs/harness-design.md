# 지속형 예약 에이전트 하네스 (aigan-harness) 설계 문서

> 버전: 2.5
> 상태: 구현 설계 확정. 콘텐츠(프롬프트)는 운영자 소유.
> 범위: 예약 기반으로 스스로 깨어나 사용자와 상호작용하는 지속형 에이전트 하네스. 프롬프트 내용은 이 문서의 범위 밖이며, §6의 콘텐츠 계약을 따른다.
> 전제: 개인 서버 설치형, 단일 사용자. 텔레그램 FE.

**2.5 변경 요약**
- `close_flow(reason, upto_id)`: 버퍼 중 `id > upto_id`(답하지 못한 것)만 `late`/인바운드 이동으로 다룬다. 이미 답한 메시지의 중복 응답 수정.
- 인바운드 흐름 개시 시 `pending` 인바운드를 `messages`로 복사하는 단계를 `open_flow`에 명시(v2.0부터 인바운드 흐름의 컨텍스트가 비어 있던 구멍).
- `run_turn` 9단계 실패 처리를 한 트랜잭션으로. 전송(6단계)은 메시지마다 세대 비교.
- 정리는 흐름이 열려 있어도 턴 사이에 실행. 정지 중에만 미룬다.
- 흐름 메시지를 읽는 모든 곳은 `ignored=0`만. `inbound_messages.source_message_id` 추가. `ignored_reason='paused'` 제거. 타이머 재조준 일반 규칙.

**2.4 변경 요약**
- `agent`·`blackout`으로 닫힐 때 버퍼에 남은 user 메시지(답하지 못한 것)는 버리지 않고 `pending` 인바운드로 옮긴다. `finish()`가 인바운드 흐름을 열어 답한다(§9 `close_flow`, §10).

**2.3 변경 요약**
- 흐름 닫기를 원자 연산 `close_flow(reason)` 하나로 정의. 모든 경로가 pending self 행을 상태 무관하게 지운다(`/pause` 뒤 유령 흐름 수정, §9).
- 정리 재시도를 큐가 아니라 DB(`flows.cleanup_next_at`)와 `cleanup_timer`로. paused·활성 흐름·재시작에서 유실되지 않는다(§8, §13.1).
- 턴의 모든 종료 경로(성공·파싱 실패·예외·abort)에서 `turn_generation`을 먼저 비교. 불일치면 재시도·`failure_count`·백오프 없이 폐기.
- 흐름이 없으면 `/resume`·복구의 밀린 플랜은 블랙아웃 여부와 무관하게 즉시. `system_catchup`은 흐름이 블랙아웃을 넘긴 경우만.
- 인바운드 개시 예약 검사는 `scheduled`·`fired` 모두. 정지 상태의 명령 처리 명시. 복구 self는 `now+min_lead`, `failure_count` 불변.

**2.2 변경 요약**
- 턴은 컨텍스트에 넣은 user 메시지까지 버퍼에서 제거한다(self 턴·디바운스 턴 중복 응답 방지, §9).
- 트리거 예약(pending self) 삭제를 `TurnTx` 안으로. 재시작 시 (d) 안전망(§15.2).
- 운영 명령은 "즉시 처리 + 워커 위임"으로 분리(§9.2). `/pause`도 `turn_generation++`.
- `/resume`·`/cancel` 모두 공통 마무리를 거친다. 공통 마무리는 루프로 명시.
- 블랙아웃 끝까지 `pending_system_event`가 남으면 턴 사이에 만료 검사·플랜 실행(`system_catchup`, §8).
- self 예약은 payload를 갖지 않는다. `end` reserve는 기본 `slot=main`, 풀 항목이 살아 있을 때만 deadline 상속. `orphaned_pool` 제거.
- `messages.turn_seq` 추가, `/cancel`은 마지막 턴 메시지 전부 삭제. `daily_calls`·`random_due` 시행은 지연 갱신.

**2.1 변경 요약**
- 플랜·압축은 도구 없음. `memory_read`는 턴·정리만. 플랜 입력은 INDEX 대신 `state.md`.
- 불변식을 타이머 조준 (a)(b)(c) + 열린 흐름의 self 예약 (d)로 재정의(§8).
- `flows.turn_count` 추가. `consume_random`은 첫 턴 커밋에서 같은 트랜잭션으로 감소.
- `due_keep`은 예약을 지우지 않는다. deadline 흐름의 reserve는 `pool_id` 상속, judged된 항목이면 폐기.
- 초기값 명시, 첫 실행 절차(§15.1).
- `TurnTx`가 reserve·흐름 닫기까지 포함. 전송은 커밋 뒤 outbox(`sent_at`)로.
- 블랙아웃은 "먼저 말 걸기"만 금지. 활성 흐름 응답은 처리, 흐름 없는 인바운드는 아침에 처리. self 예약은 블랙아웃 보정 없이, 블랙아웃 중 발화하면 응답이 없을 때 흐름을 닫는다.
- continue의 무효 `reserve.prompt`는 `flows.prompt`로 대체. 실패 백오프는 self 예약.

---

## 1. 개요와 원칙

### 1.1 이 하네스가 하는 일

에이전트가 **정해진 시각에 스스로 깨어나** 사용자에게 말을 걸고, 사용자의 응답을 받아 대화를 이어가고, 다음에 언제 깨어날지를 스스로 정하는 하네스다. 대화는 흐름(flow) 단위로 열리고 닫히며, 닫힐 때 기억 쓰기 호출이 돈다. 비동기 작업은 별도 풀에서 마감과 함께 관리되고, 하루 단위 계획이 블랙아웃(사용자가 자는 시간)에 그려진다.

프롬프트 파일을 교체하면 비서, 코치, 튜터, 저널링 봇, 리마인더 등으로 용도가 바뀐다. 하네스는 그 파일들이 무엇을 하는지 모른다.

### 1.2 원칙

1. **직렬성은 구조로 보장한다.** 워커가 하나라서 동시성 문제가 없다. 수신 핸들러는 큐를 거치지 않고 버퍼에만 쓴다.
2. **불변식은 하네스가 강제한다.** 타이머 조준, "활성 흐름 최대 1개", "열린 흐름은 항상 다음 턴 예약을 가진다"(§8), "블랙아웃에는 먼저 말을 걸지 않음"은 프롬프트 부탁이 아니라 코드다.
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
| **블랙아웃** | 시스템이 **먼저** 말을 거는 것이 금지되는 시간대. 활성 흐름에서 사용자 응답에 답하는 것은 허용. 플랜과 만료 검사가 이 진입 시각에 돈다 |
| **INDEX** | `memory/*.md`의 `description` frontmatter에서 생성되는 목록. 매 턴 컨텍스트에 들어간다 |
| **인바운드** | 사용자가 흐름 밖에서 보내는 메시지. 응답이 보장되지 않는다 |
| **플랜** | 블랙아웃에 그리는 하루 계획. `plan_items` 테이블 |
| **비동기 풀** | 마감이 있는 작업 목록. `pool_items` 테이블 |
| **압축** | 현재 흐름 대화가 임계를 넘으면 오래된 부분을 요약으로 대체하는 것 |
| **deferred** | 발화했으나 처리하지 못한 예약. `state='fired'` |
| **`DATA_DIR`** | 설정·프롬프트·기억 파일·DB가 사는 디렉터리. 볼륨으로 마운트된다 |
| **`TurnTx`** | 한 턴의 모든 상태 변경(도구 효과·메시지 저장·reserve·흐름 닫기)을 모으는 트랜잭션. 최종 JSON 성공 시 commit(§9) |
| **outbox** | `messages`의 `sent_at IS NULL`인 assistant 행. 커밋됐지만 아직 전송되지 않은 메시지 |
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
cleanup_timer (MIN flows.cleanup_next_at) ─────────────▶
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
| `turn_generation` | INTEGER | 턴 세대 카운터. `/cancel`·`/pause` 시 증가 |
| `pending_system_event` | INTEGER | 0/1. 흐름 중 블랙아웃 진입이 발생해 만료 검사·플랜이 밀렸음을 표시 |

`mode`는 `active/paused` 둘. "흐름 사이"는 `current_flow_id IS NULL`.

**초기값**(§15.1): `mode='paused'`, `current_flow_id=NULL`, 모든 카운터(`random_due`, `failure_count`, `daily_calls`, `turn_generation`, `pending_system_event`) 0, `last_roll_at`·`last_plan_date`·`pause_reason`·`daily_calls_date` NULL.

**`random_due`의 발생과 감소**
- 발생: 단위 시간(`random.unit_sec`)마다 확률 `random.prob`로 1 증가, `random.max_due` 상한. 블랙아웃에도 증가. `last_roll_at`이 마지막 시행 시각. **지연 시행**: 타이머를 따로 두지 않고, 워커가 이벤트를 처리하기 직전에 `last_roll_at` 이후 지난 단위 수만큼 주사위를 굴리고 `last_roll_at`을 그만큼 전진시킨다. 재시작이 길어도 놓친 시행이 없다.
- 감소: 흐름의 **첫 턴**(`flows.turn_count`가 0→1이 되는 커밋)에서 `consume_random=true`면 **같은 `TurnTx` 안에서** 1 감소(하한 0). 발화 시점이 아니다(부록 B). 첫 턴에서 false거나 없으면 그 흐름은 이후 턴에서 true를 내도 감소하지 않는다.

**`daily_calls`** — LLM API 요청 1건마다 1 증가(도구 라운드 포함). **지연 리셋**: 요청 직전에 `daily_calls_date`가 오늘(로컬)이 아니면 `daily_calls=0`, `daily_calls_date=오늘`. 자정 타이머에 의존하지 않으므로 재시작이 자정을 넘겨도 안전하다.

**파생 상태**

| 이름 | 조건 |
|---|---|
| 정지 | `mode=paused` |
| 흐름 없음 | `mode=active` and `current_flow_id IS NULL` |
| 흐름 있음 | `current_flow_id IS NOT NULL` |

---

## 4. 이벤트 처리 표

큐 이벤트는 여섯: `debounce_expiry`, `reservation_due(id)`, `system_event`, `system_catchup`, `cleanup_due`, `command(name)`. `command`는 큐 맨 앞에 들어간다(§9.2). 큐는 휘발성이다—`command`를 뺀 모든 이벤트는 DB 상태(`fired`, `pending_system_event`, `last_plan_date`, `cleanup_next_at`)에서 다시 만들어질 수 있어야 한다.

| 이벤트 | 정지 | 흐름 없음 | 흐름 있음 |
|---|---|---|---|
| `debounce_expiry` | 버퍼 비움 | 대기 인바운드가 있고 인바운드 개시 예약(§10)이 없으면 → 인바운드 예약 생성(`at=now`, 블랙아웃 밖으로 보정). 아니면 무시 | 버퍼가 비어 있지 않으면 → 턴 트리거. 비어 있으면 무시 |
| `reservation_due(id)` | 무시(예약 보존) | 예약 소비, 새 흐름 개시 | **id == `current_flow.pending_self_reservation_id`** → 턴 트리거, 행 삭제는 그 턴의 `TurnTx`(블랙아웃 중이면 §9 블랙아웃 규칙). **아니면** `state='fired'` 유지(deferred). 흐름 종료 시 처리 |
| `system_event` | 무시 | 만료 검사 → 플랜 | **`pending_system_event=1` 설정 후 종료**(재큐 없음). 흐름 종료 시 또는 `system_catchup`에서 처리 |
| `system_catchup` | 무시 | `pending_system_event=1`이면 리셋 후 만료 검사 → 플랜. 아니면 무시 | 같음. 턴 사이이므로 흐름을 닫지 않고 실행. 만료 검사는 활성 흐름의 `origin_pool_id`를 제외(§8) |
| `cleanup_due` | 무시(`/resume`에서 재조준) | `cleanup_next_at <= now`인 pending 흐름을 가장 이른 것부터 하나 실행 | 같음. 턴 사이이므로 활성 흐름과 경합 없음 |

self-reserve 판정은 id 기반(부록 B).

**deferred 처리 순서**
- 흐름이 닫히면 `reservations WHERE state='fired' ORDER BY at ASC, id ASC LIMIT 1`을 조회해 가장 이른 것을 처리.
- 처리 방식은 `reservation_due`와 동일. 하나 처리하면 그 흐름이 열리고, 나머지는 그 흐름이 닫힌 뒤 다시 조회.
- deferred가 모두 소진된 뒤에 `pending_system_event`를 확인.
- 구현은 재귀가 아니라 루프다(§9 공통 마무리).

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
| `payload` | TEXT / NULL | `slot='deadline'`이고 흐름 개시용이면 `{"pool_id":N}`. self 예약·그 외는 NULL |
| `created_at` | TEXT | |

| 전이 | 조건 |
|---|---|
| 생성 | LLM `reserve`(slot 규칙은 아래), `pool_create`(slot=deadline), 인바운드 도착(no-flow, slot=inbound), 실패 백오프·복구 안전망(self 예약). `state='scheduled'` |
| 발화 | 타이머 → `state='fired'`, `reservation_due(id)` 큐 투입 |
| 소비 | 흐름 개시: 개시 시 행 삭제. self 턴: 그 턴의 `TurnTx`에서 행 삭제(실패·크래시 시 행이 남는다) |
| 보류 | 발화했으나 처리 못 함. `state='fired'` 유지(deferred) |
| 교체 | 턴 커밋 시 기존 `pending_self_reservation_id` 행 삭제 후 새 예약(`TurnTx` 안) |
| 삭제 | `close_flow`가 `pending_self_reservation_id` 행을 상태(`scheduled`·`fired`) 무관하게 삭제(§9). `end`의 `reserve`는 다음 흐름 개시용으로만 생성되고 pending에 넣지 않는다 |

**클램프 규칙 (생성 시)**

| 원천 | `at` 규칙 |
|---|---|
| LLM `reserve`(`flow=end`, 다음 흐름 개시) | `clamp(now+min_lead, now+max_lead)`, 블랙아웃이면 그 끝으로 |
| LLM `reserve`(`flow=continue`, self) · 실패 백오프 | `clamp(now+min_lead, now+max_lead)`. **블랙아웃 보정 안 함**(§9 블랙아웃 규칙) |
| `pool_create` | `deadline` 그대로. 과거면 `now+min_lead`, `now+pool_ttl` 초과면 거부. 블랙아웃이면 그 끝으로 |
| 인바운드 도착 | `now`. 블랙아웃 밖으로 보정(블랙아웃 중 도착이면 그 끝) |

**생성 시 prompt 결정**
- LLM `reserve`: `reserve.prompt`. 무효(`prompts/jobs/` 밖, 파일 없음·읽기 불가)면:
  - `flow=continue`: 흐름의 마지막 성공 프롬프트(`flows.prompt`)로 대체, 로그. 불변식 (d)를 지킨다.
  - `flow=end`: 그 예약만 폐기, 로그.
- 실패 백오프: 실패한 턴이 사용한 프롬프트.
- `pool_create`: 그 도구 호출의 `prompt` 인자(§7.2).
- 인바운드 도착: config의 `inbound_prompt`.

**slot·payload 규칙**

`reserve`는 slot을 지정하지 않는다. 하네스가 정한다.

| 예약 | slot | payload |
|---|---|---|
| self(`continue`, 실패 백오프, 복구 self) | 흐름의 `origin_slot` | **NULL**. 흐름이 이미 `origin_pool_id`를 안다 |
| `end` reserve(다음 흐름 개시) | 기본 `main`. 흐름이 deadline 흐름이고 `origin_pool_id` 항목이 `pending`/`due`면(`TurnTx` 반영 후 상태 기준) `deadline` | `deadline`이면 `{"pool_id": origin_pool_id}`, 아니면 NULL |
| 플랜 reserve | `main` | NULL |

- self 예약은 payload가 없으므로 `pool_id` 기준 삭제(판정·재발행·만료)에 휘말리지 않는다. 불변식 (d)가 풀 상태에 흔들리지 않는다.
- `end` reserve의 `main` 귀결은 강등이 아니다. 슬롯은 "누가 이 흐름을 열었나"만 뜻하고, 다음 일반 흐름은 원래 `main`이다. 인바운드 흐름의 `end` reserve도 `main`이므로, 하네스가 만드는 인바운드 예약의 중복 검사(§10)를 막지 않는다.

### 5.2 흐름 (`flows`)

| 컬럼 | 타입 | 비고 |
|---|---|---|
| `id` | INTEGER PK | |
| `origin_slot` | TEXT | 이 흐름을 연 예약의 slot. self 예약의 slot |
| `origin_reservation_id` | INTEGER | 삭제된 행을 가리켜도 무해. 기록용 |
| `origin_pool_id` | INTEGER / NULL | `origin_slot='deadline'`이면 origin 예약의 `payload.pool_id`. 이벤트 블록·`end` reserve 상속·만료 제외용 |
| `pending_self_reservation_id` | INTEGER / NULL | 이 흐름의 다음 턴 예약 id |
| `prompt` | TEXT | 마지막 성공 턴의 프롬프트 파일 경로. 개시 시 origin 예약의 prompt |
| `turn_count` | INTEGER | 커밋된 턴 수. 0에서 시작, 턴 커밋마다 1 증가 |
| `started_at` | TEXT | |
| `ended_at` | TEXT / NULL | |
| `end_reason` | TEXT / NULL | agent / paused / cancelled / blackout |
| `cleanup_status` | TEXT | pending / done / skipped |
| `cleanup_next_at` | TEXT / NULL | `pending`일 때 다음 정리 시도 시각. `cleanup_timer`가 조준 |
| `cleanup_attempts` | INTEGER | 정리 시도 횟수. 백오프 계산용 |
| `summary` | TEXT / NULL | 압축된 대화 요약 |
| `compacted_until_id` | INTEGER / NULL | 압축이 커버한 마지막 message id |

| 전이 | 조건 |
|---|---|
| 열림 | 예약 소비 → `current_flow_id` 설정, origin·prompt 기록, `turn_count=0` |
| 턴 | self-reserve 또는 디바운스. 커밋 시 `turn_count++`, `prompt`를 이 턴의 프롬프트로, `pending_self_reservation_id` 갱신 |
| 압축 | 응답 전송 뒤 문자 임계 초과 시 `summary`·`compacted_until_id` 갱신 |
| 닫힘 | LLM `flow=end`, `/pause`, `/cancel`, 블랙아웃 규칙 → `close_flow(reason)`(§9) → 정리 동기 실행(`cancelled`면 skip) |
| 정리 완료 | `cleanup_status=done`, `cleanup_next_at=NULL` |
| 정리 실패 | `cleanup_attempts++`, `cleanup_next_at=now+백오프`(§13.1) |

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
| `due` | deadline 예약 발화. `due_at`이 NULL일 때만 `now`(처음 due가 된 시각 유지) |
| `judged` | `pool_judge(judged)`, `expired`, `reissued`, `cancelled` |
| `due_keep` | `pool_judge(due_keep)` → `due` 유지. 예약은 건드리지 않음 |

**`judged`로 닫힐 때만**(`close_reason` 무관) 해당 `pool_id`의 deadline 예약(`scheduled`·`fired`)을 삭제한다(부록 B). `due_keep`은 삭제하지 않는다. 재검사는 흐름의 `end` reserve가 만드는 새 deadline 예약(§5.1)으로 한다. self 예약은 payload가 없으므로 이 삭제의 대상이 아니다. `due_keep` 후 reserve가 없으면 항목은 `due`로 남아 이벤트 블록에 노출되다가 `pool_ttl` 만료로 닫힌다.

### 5.4 인바운드 (`inbound_messages`)

`id`, `content`, `received_at`, `status`(pending/consumed/expired), `consumed_at`, `consumed_flow_id`, `source_message_id`(NULL 또는 `close_flow`가 옮긴 원본 `messages.id`). 추적 체인: 원본 `messages.id` → `source_message_id` → `consumed_flow_id`의 복사본.

| 전이 | 조건 |
|---|---|
| `pending` | 수신(흐름 없음). 블랙아웃 중에도 저장(§10). 또는 `close_flow`가 답하지 못한 버퍼 메시지를 옮김(§9) |
| `consumed` | 인바운드 흐름 개시(`open_flow`) 시 전부 `messages`로 복사하고 소비 표시. `consumed_flow_id` 기록 |
| `expired` | 만료 검사(시간 초과 또는 N건 초과 시 오래된 것부터) |

### 5.5 플랜 (`plan_items`)

`id`, `text`, `hint`(NULL), `done`(0/1), `created_at`, `plan_date`.

| 전이 | 조건 |
|---|---|
| 생성·교체 | 플랜 호출의 `items` 출력으로 전체 교체. 새 `plan_date`면 이전 날짜 행 전체 삭제 |
| 체크 | `plan_done(id)` |
| 추가 | `plan_add(text, hint?)` |

### 5.6 메시지 (`messages`)

`id`, `flow_id`, `role`(user/assistant), `content`, `ts`, `ignored`(0/1), `ignored_reason`(late/moved/undelivered), `sent_at`(assistant만, NULL=미전송), `tg_message_id`(assistant만, 전송 성공 시), `turn_seq`(assistant만, 커밋 시점의 `flows.turn_count`. 한 턴의 메시지를 묶는다).

**outbox**: assistant 메시지는 `TurnTx` 안에서 `sent_at=NULL`로 저장되고, 커밋 뒤 전송이 성공할 때마다 하나씩 `sent_at`·`tg_message_id`를 채운다. 재시작 시 `sent_at IS NULL`인 assistant 행을 `id` 순으로 재전송한다(§15.2). 텔레그램 ack와 마킹 사이 크래시만 중복을 낳는다.

**흐름 메시지를 읽는 모든 곳—턴 컨텍스트, 정리 입력, 압축 대상, 압축 임계 계산—은 `ignored=0`만 본다.** `late`·`moved`·`undelivered`는 기록으로만 남는다.

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
| 5 | system | job prompt | self 예약 트리거면 그 예약의 `prompt`, 디바운스 트리거면 `flows.prompt`가 가리키는 파일 |
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

플랜 `reserve`가 null이면 하네스는 다음 블랙아웃까지 먼저 말을 걸지 않는다. 특히 첫 플랜(§15.1)은 `plan-rules.md`가 reserve를 내도록 규정해야 한다.

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
- 흐름의 `origin_pool_id`가 있으면 해당 풀 항목 전문을 `pool` 위에 별도 줄로 넣는다(5개 상한 미포함).

### 6.3 시스템 작업 조립

| 호출 | 블록 |
|---|---|
| 플랜 | `plan-rules.md` + `state.md` + 이벤트 블록(블랙아웃 진입, 오늘 날짜, 어제 미완 요약) |
| 정리 | `cleanup-rules.md` + INDEX + `state.md` + (`flows.summary` + `id > compacted_until_id AND ignored=0`인 메시지) |
| 압축 | `compact-rules.md` + 기존 `summary` + 압축 대상 구간 |

persona·call-rules는 시스템 작업에 넣지 않는다. 플랜·압축은 도구가 없으므로 INDEX를 넣지 않는다(열 수 없는 목록은 낭비다). 플랜에 필요한 상시 정보는 `state.md`에 있어야 한다.

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
- `reserve`에는 slot이 없다. slot·payload는 하네스가 정한다(§5.1).
- `reserve.prompt`는 `prompts/jobs/` 아래 파일 경로. 무효면 `continue`는 `flows.prompt`로 대체, `end`는 그 예약만 폐기(§5.1).
- `consume_random`: 선택, 기본 false. 흐름의 첫 턴(`turn_count` 0→1)에서만 의미가 있고, true면 같은 커밋에서 `random_due` 1 감소(§3).

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
| `memory_read` | `name: string` | 턴, 정리 |
| `memory_write` | `name: string`, `content: string` | 정리 |
| `memory_create` | `name: string`, `description: string`, `content: string` | 정리 |
| `pool_judge` | `id: integer`, `verdict: "judged" \| "due_keep"` | 턴 |
| `pool_create` | `task: string`, `deadline: string`, `prompt: string`, `replaces?: integer` | 턴 |
| `plan_done` | `id: integer` | 턴 |
| `plan_add` | `text: string`, `hint?: string` | 턴 |

플랜·압축 호출은 도구를 쓰지 않는다(`tools` 미제공)—플랜은 출력의 `items`가, 압축은 `summary`가 곧 결과다. 도구 목록은 턴·정리 호출별로 분리 제공. 목록에 없는 도구를 지어내 호출하면 거부 결과를 돌려준다.

**도구 검증**
- `pool_judge`: 없는 id·이미 `judged`면 거부 결과. `pending`/`due`면 판정. `judged`일 때만 deadline 예약 삭제.
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
| `reserve.prompt` 파일 없음/불가 | `continue`: `flows.prompt`로 대체. `end`: 그 예약만 폐기. 로그 |
| `at` 과거/범위 밖 | 클램프(§5.1) |
| 재시도도 실패 | 응답 통째 폐기. `failure_count++`, 백오프 예약을 **self 예약으로 등록**(`pending_self_reservation_id`, prompt=실패한 턴의 프롬프트), `flow` 유지. `alert_after` 도달 시 운영자 알림 |

실패한 응답은 `messages`도 전송하지 않는다.

### 7.4 도구 라운드와 강제 JSON

- 도구 호출·결과 전달을 최대 `max_tool_rounds`(정리는 `max_cleanup_tool_rounds`)회 반복 후 최종 JSON. 플랜·압축은 도구 라운드 없음.
- 상한 초과 시 `tools` 유지 + `tool_choice: "none"`으로 한 번 더 호출.
- 도구 쓰기 효과는 `TurnTx`/`MemoryTx`에 모았다가 최종 JSON 성공 시 일괄 commit.

---

## 8. 예약과 타이머

**재조준 일반 규칙**: 모든 타이머(`flow_timer`, `system_timer`, `cleanup_timer`, 디바운스)는 자기 조준식의 입력이 바뀌는 쓰기 직후 재조준한다. 예: `pending_system_event`가 0↔1로 바뀌면 `system_timer`, `cleanup_next_at`이 바뀌면 `cleanup_timer`.

**flow_timer**: `MIN(reservations.at) WHERE state='scheduled'` 조준. 삽입·삭제·갱신 시 재조준. 발화 시 `state='fired'` + `reservation_due(id)` 큐 투입.

**system_timer**: `MIN(다음 블랙아웃 진입, 진행 중인 블랙아웃의 끝 — pending_system_event=1이고 흐름이 열려 있을 때만)`을 조준한다. 진입 시각이면 `system_event`, 끝 시각이면 `system_catchup`을 큐에 넣는다. `last_plan_date`가 오늘이면 진입은 다음 날로 건너뛴다. 끝 시각이 이미 지났으면 즉시 발화.

**cleanup_timer**: `MIN(flows.cleanup_next_at) WHERE cleanup_status='pending'`을 조준한다. 발화 시 `cleanup_due` 큐 투입. 흐름이 열려 있어도 발화·실행한다. 정지 중에는 꺼지고 `/resume`과 재시작 복구에서 재조준된다. 이 타이머가 정리 재시도의 유일한 경로다.

**system_catchup**: 흐름이 없으면 밀린 만료 검사·플랜은 `finish()`가 즉시 처리하므로(블랙아웃 여부 무관—플랜은 원래 블랙아웃 안에서 도는 작업이다) catchup은 쓰이지 않는다. 블랙아웃이 끝났는데도 흐름이 닫히지 않아 만료 검사·플랜이 밀려 있으면, 흐름을 닫지 않고 턴 사이(워커가 이 이벤트를 처리하는 시점)에서 실행한다. 워커가 직렬이므로 경합은 없다. 부작용은 둘이고 둘 다 수용한다: (1) 플랜 교체로 LLM이 본 `plan_done(id)`가 거부될 수 있다—도구 거부 결과로 돌아온다. (2) 활성 흐름이 다루는 풀 항목이 만료될 수 있다—만료 검사에서 활성 흐름의 `origin_pool_id`를 제외한다. 플랜 지연은 최대 블랙아웃 길이로 제한된다.

**불변식**

| # | 내용 |
|---|---|
| (a) | `mode=active`면 `system_timer`는 항상 다음 블랙아웃 진입을 조준한다 |
| (b) | `state='scheduled'` 행이 있으면 `flow_timer`는 `MIN(at)`을 조준한다 |
| (c) | 활성 흐름은 최대 1개(`current_flow_id` 단일 값) |
| (d) | 열린 흐름은 턴 실행 중이 아니면 항상 `pending_self_reservation_id`(`scheduled` 행)를 가진다 |

"deadlock 없음"은 (a)+(d)에서 파생된다. 흐름이 없으면 (a)가 늦어도 다음 블랙아웃에 시스템을 깨우고, 흐름이 있으면 (d)의 self 예약이 언젠가 발화해 턴을 돌리거나 흐름을 닫는다(§9 블랙아웃 규칙). (d)를 지키는 장치: continue의 무효 prompt 대체(§5.1), 실패 백오프의 self 등록(§7.3), self 예약에 payload 없음(§5.1), 트리거 예약 삭제를 `TurnTx` 안에서(§9), 세대 불일치 시 백오프 없음(§9), 재시작 복구 self(§15.2). `fired`(deferred)는 불변식에 포함되지 않는다.

**블랙아웃 보정**: self 예약을 제외한 예약 `at`이 블랙아웃이면 그 끝으로 민다. 발화 시점에 다시 확인(self가 아닌 예약이 블랙아웃 중 발화하면 다시 끝으로 민다). self 예약의 블랙아웃 발화는 §9 블랙아웃 규칙을 따른다. 설정에서 블랙아웃이 비면 시작 검증에서 실패시킨다.

**DST·자정 넘김**: "그날 첫 진입"은 로컬 날짜 변경으로 판정(luxon `toISODate()`). 블랙아웃이 자정을 넘어도 진입은 하루 한 번.

---

## 9. 워커 처리 상세

```
loop:
  event = queue.pop()
  if event.type == command: handle_command(event.name); continue   # paused여도 처리
  if mode == paused: continue
  roll_random()                                                       # 지연 시행(§3)
  switch event.type:
    case debounce_expiry: handle_debounce()
    case reservation_due: handle_reservation(event.id)
    case system_event:   handle_system()
    case system_catchup: handle_catchup()
    case cleanup_due:    handle_cleanup()
  if current_flow_id IS NULL and (이번 이벤트에서 흐름이 닫혔음 or 이벤트가 command): finish()
```

**handle_debounce**
- 흐름 없음: 대기 인바운드 有 & 인바운드 개시 예약 無(`scheduled`·`fired` 모두 확인, §10) → 인바운드 예약 생성. 아니면 무시.
- 흐름 있음: 버퍼 비었으면 무시. 아니면 `run_turn(buffered)`.

**handle_reservation(id)**
- 행 조회. 없으면 폐기.
- 흐름 없음: 소비 → `open_flow(id)` → `run_turn(self)`.

**open_flow(reservation)** — 한 트랜잭션에서:
1. 예약 행 삭제, `flows` 행 생성(origin·prompt, `turn_count=0`), `current_flow_id` 설정.
2. `slot='deadline'`이면 풀 항목 `due` 전이(`due_at`은 처음만), `origin_pool_id` 기록.
3. `slot='inbound'`면 `pending` 인바운드 전부를 `id` 순으로 `messages`에 복사(`role='user'`, `flow_id`=새 흐름, `ts=received_at`, `ignored=0`)하고 `consumed`, `consumed_at`, `consumed_flow_id` 기록. 첫 턴 컨텍스트(§6.1 6번 블록)는 이 복사본을 읽는다.
- 흐름 있음 & id == pending_self: 블랙아웃 중이면 아래 블랙아웃 규칙, 아니면 `run_turn(self)`. 행 삭제는 그 턴의 `TurnTx`에서 한다.
- 흐름 있음 & 그 외: `state='fired'` 유지(deferred).

**블랙아웃 규칙 (self 예약)**

self 예약은 생성 시 블랙아웃 보정을 받지 않는다(§5.1). 블랙아웃 중 발화하면:
- 그 흐름에 **마지막 assistant 메시지 뒤 유효 user 메시지가 있으면**(응답 대기 중—실패 백오프 재시도 등) → `run_turn(self)`. 사용자에게 답하는 것이므로 허용.
- 없으면 → 시스템이 먼저 말을 거는 셈이므로 턴을 돌리지 않고 `close_flow('blackout', 0)`. 이 `fired` self 행도 `close_flow`가 지운다. 정리 실행 후 공통 마무리(deferred → `pending_system_event` → 플랜).

즉 블랙아웃 중 self 예약은 "그때까지 사용자가 답이 없으면 흐름을 접는다"는 의미가 된다. 사용자가 계속 대화하는 동안은 디바운스 턴으로 흐름이 이어지고, 대화가 끊기면 늦어도 self 예약 시각에 흐름이 닫혀 플랜이 돈다.

**handle_system**
- 흐름 있음: `pending_system_event=1`, 종료.
- 흐름 없음: 만료 검사(인바운드·풀) → 플랜 실행.

**handle_catchup** — `pending_system_event=0`이면 무시. 1이면 리셋 후 만료 검사(활성 흐름의 `origin_pool_id` 제외) → 플랜. 흐름은 그대로 둔다(§8).

**handle_cleanup** — 흐름이 열려 있어도 실행한다(이미 닫힌 **다른** 흐름의 기록을 기억 파일에 쓰는 일이라 사용자 접점이 없고, 워커가 직렬이라 경합도 없다. 활성 흐름은 다음 턴에 갱신된 `state.md`를 본다). `cleanup_status='pending' AND cleanup_next_at <= now`인 흐름을 `cleanup_next_at` 순으로 하나 실행. 성공 시 `done`, 실패 시 §13.1 백오프. 끝나면 `cleanup_timer` 재조준.

**close_flow(reason, upto_id)** — 흐름을 닫는 **유일한** 연산. `upto_id`는 이 닫기를 일으킨 커밋된 턴의 `upto_id`이고, 턴 밖(`/pause`, `/cancel`, 블랙아웃 규칙)이나 폐기된 턴이면 0이다. 한 트랜잭션(턴 안이면 그 `TurnTx`)에서:
1. `pending_self_reservation_id` 행 삭제(`scheduled`·`fired` 무관).
2. `ended_at=now`, `end_reason=reason`.
3. `cleanup_status`: `reason='cancelled'`이거나 이 시점에 `cleanup-rules.md`가 없으면 `skipped`(최종. 나중에 파일이 생겨도 소급하지 않는다—파일 부재는 운영자가 정리를 끈 것이다), 아니면 `pending` + `cleanup_next_at=now`, `cleanup_attempts=0`.
4. 버퍼 중 `id > upto_id`인 user 메시지(이 흐름이 답하지 못한 것) 처리. `id <= upto_id`는 이미 답했으므로 손대지 않는다. 처리 후 버퍼 비움, 디바운스 타이머 취소.
   - `paused`·`cancelled`: `ignored=1, ignored_reason='late'`. 사용자가 멈추라고 했으므로 답하지 않는다.
   - `agent`·`blackout`: 각 메시지를 `inbound_messages`에 `pending`으로 복사(`received_at`=원래 `ts`, `source_message_id`=원래 `id`)하고, 원래 행은 `ignored=1, ignored_reason='moved'`. 흐름 컨텍스트에서는 빠지고, `finish()`가 인바운드 개시 예약을 만들어 다음 인바운드 흐름이 답한다. 블랙아웃 중이면 그 예약은 블랙아웃 끝으로 밀린다(§5.1).
5. `current_flow_id=NULL`, `pending_self_reservation_id=NULL`.

정리(`pending`이면)는 커밋·전송 뒤 워커가 동기로 한 번 시도한다. 실패해도 `cleanup_next_at`이 있으므로 `cleanup_timer`가 잇는다.

**run_turn(trigger)**
1. `balance_guard`(§9.1). 초과 시 `pause_reason` 설정, 이벤트 재큐, 종료.
2. 컨텍스트 조립. 포함한 user 메시지의 최대 `messages.id`를 `upto_id`로 기록.
3. `turn_executor` → 파싱. **`turn_generation`을 시작 시 읽고, 호출이 어떻게 끝나든(성공·파싱 실패·예외·abort) 가장 먼저 비교한다.** 다르면 도구 라운드 동안 모은 `TurnTx` 효과를 버리고(커밋하지 않음) 로그만 남긴 뒤 끝낸다. 파싱 재시도, `failure_count`, 백오프 self 모두 하지 않는다(부록 B).
4. `TurnTx` commit — 아래가 **한 트랜잭션**이다.
   - 기존 `pending_self_reservation_id` 행 삭제(self 트리거면 그 트리거 예약, 디바운스 트리거면 대기 중이던 self). LLM 호출 중 옛 self가 발화했어도 그 이벤트는 큐에서 기다리다가 "행 없음"으로 폐기된다.
   - 도구 쓰기 효과(풀·플랜).
   - assistant 메시지 저장(`sent_at=NULL`, `turn_seq`, outbox).
   - `turn_count++`, `flows.prompt` 갱신, `failure_count=0`.
   - 첫 턴(`turn_count` 0→1)이고 `consume_random=true`면 `random_due` 1 감소.
   - `reserve` 반영(§5.1 prompt·slot 규칙). `continue`면 self 예약 생성 + pending 갱신. `end`면 다음 흐름 개시 예약만 생성, pending NULL.
   - `flow=end`면 `close_flow('agent', upto_id)`.
5. 커밋 직후 디바운스 버퍼에서 `id <= upto_id`인 항목 제거. 버퍼가 비면 디바운스 타이머 취소. LLM 호출 중 도착한 메시지는 남아 다음 디바운스 턴에서 처리된다. self 턴과 디바운스 턴이 같은 user 메시지에 두 번 답하지 않는다.
6. outbox 전송. **메시지 하나를 보내기 직전마다 `turn_generation`을 비교**한다. 커밋 뒤 전송 도중 `/cancel`·`/pause`가 오면 3단계 비교로는 못 잡기 때문이다. 바뀌었으면 전송을 멈추고 남은 메시지는 `ignored=1, ignored_reason='undelivered'`. 성공한 메시지마다 `sent_at`·`tg_message_id` 기록.
7. 흐름이 닫혔고 `cleanup_status='pending'`이면 `cleanup_runner` 동기 1회 시도. 실패 시 `cleanup_next_at`에 백오프(§13.1). 그다음 공통 마무리.
8. 흐름이 열려 있으면 압축 검사(§13.2).
9. 실패(세대 일치, 재시도까지): `TurnTx` 효과는 버리고, **별도의 한 트랜잭션**에서 `failure_count++` + 기존 pending self 행 삭제 + 백오프 self 예약 삽입 + `pending_self_reservation_id` 갱신(§7.3). 흐름 유지. 중간 상태로 (d)가 깨지지 않는다. 버퍼는 건드리지 않는다—백오프 턴이 같은 메시지를 다시 컨텍스트에 넣는다.

커밋 후 전송 전 크래시는 메시지가 outbox에 남아 재시작 시 재전송된다(§15.2). 상태와 대화 기록은 이미 진행돼 있으므로 다음 턴의 컨텍스트는 실제와 어긋나지 않는다.

**흐름 종료 후 공통 마무리 (deferred + system_event)**

흐름이 닫히는 모든 경로—정상 종료, 블랙아웃 규칙, `/cancel`, 재시작 복구—와 `/resume`에서 실행한다. `/pause`는 예외. **재귀가 아니라 루프**다. 끝에서 `cleanup_timer`와 `system_timer`를 재조준한다.

```
finish():
  while current_flow_id IS NULL:
    r = SELECT ... WHERE state='fired' ORDER BY at, id LIMIT 1
    if r is None: break
    open_flow(r) → run_turn(self)   # 첫 턴에서 흐름이 닫히면 루프 계속, 열려 있으면 종료
  if current_flow_id IS NULL and pending_system_event == 1:
    pending_system_event = 0; 만료 검사 → 플랜     # 블랙아웃 여부 무관, 즉시
  if current_flow_id IS NULL and 대기 인바운드 有 and 인바운드 개시 예약 無:
    인바운드 예약 생성(§10)
  재조준(cleanup_timer, system_timer)
```

흐름이 열린 채로 루프가 끝나면 남은 deferred는 그 흐름이 닫힐 때 다시 `finish()`가 처리한다. `run_turn` 안에서 `finish()`를 부르지 않고, 워커가 이벤트 처리 끝에 `current_flow_id`가 NULL로 바뀌었으면 `finish()`를 부른다.

### 9.1 `balance_guard`

- **provider** (`openai` | `deepseek`): `openai`는 잔액 확인 안 함. `deepseek`는 `/user/balance` 호출, 응답 `currency` 로그, `balance_threshold`와 비교(계정 통화). 통화 불일치 시 경고 후 비교.
- 잔액 부족: `pause_reason='balance'`, 이벤트 재큐, `balance_retry_sec` 뒤 재확인.
- 일일 상한: `daily_calls >= daily_call_limit`이면 `pause_reason='daily_limit'`, 다음 로컬 자정까지 보류.
- 보류 중 도착 메시지는 버퍼/인바운드에 쌓였다가 재개 시 처리. `/resume` 시 `pause_reason=NULL`.

### 9.2 운영 명령 상태 전이

운영 명령은 `command_handler`가 받는다. **LLM 호출·흐름 개시·흐름 닫기는 워커만 한다**(원칙 1). 그래서 각 명령을 둘로 나눈다.

| 명령 | 정지 상태에서 | `command_handler`(즉시, 정지 아님) | 워커(`command` 이벤트, 큐 맨 앞) |
|---|---|---|---|
| `/pause` | "이미 일시정지" 안내만 | `turn_generation++`, 진행 중 LLM 호출 abort | 흐름 있으면 `close_flow('paused', 0)` → 정리 1회 시도. 그다음 `mode=paused`, 모든 타이머 정지. deferred 미처리 |
| `/resume` | 워커로 | 없음 | `mode=active`, `pause_reason=NULL`, `last_plan_date` 미완이면 `pending_system_event=1`, 공통 마무리 `finish()`(밀린 플랜 즉시, 타이머 재조준 포함) |
| `/cancel` | "진행 중인 흐름 없음" 안내만 | `turn_generation++`, 진행 중 LLM 호출 abort | 흐름 없으면 안내만. `close_flow('cancelled', 0)`(정리 skip), 마지막 턴 메시지 삭제 시도, 공통 마무리 `finish()` |

정지 상태에서는 `command_handler`가 세대 카운터를 올리지 않는다(진행 중인 턴이 없다).

- `turn_generation++`가 즉시여야 진행 중인 턴이 파싱 직후 비교에서 폐기된다. `/pause`도 올리지 않으면 흐름이 닫힌 뒤 진행 중이던 턴이 커밋된다.
- `mode=paused`는 워커가 흐름 닫기·정리를 마친 뒤에 세운다. 순서가 바뀌면 닫기·정리 전에 정지 상태가 되어 상태 전이가 꼬인다. `command` 이벤트 자체는 paused여도 처리된다(§9 루프).
- 명령 확인 메시지("일시정지했어" 등)는 워커 처리 후 보낸다.

**403(차단)**: `messages` 전송 중 403이면 남은 전송 중단, `/pause`와 동일 처리. 이미 보낸 것은 유지, 남은 것은 `sent_at=NULL` + `ignored=1, ignored_reason='undelivered'`로 표시한다. 재개 후 재전송하지 않고, 컨텍스트에서도 빠져 LLM이 사용자가 보지 못한 말을 본 것으로 착각하지 않는다.

**`/cancel`의 봇 메시지 삭제**: 그 흐름에서 `turn_seq`가 가장 큰 턴의 assistant 메시지 중 `tg_message_id`가 있는 것 전부. 한 턴의 응답만 지우므로 중간이 잘리지 않고, 그 이전 맥락은 남는다. 텔레그램 삭제 실패(48시간 경과 등)는 로그만.

---

## 10. 인바운드 처리

**수신(흐름 없음)**: 블랙아웃 여부와 무관하게 `inbound_messages`에 `pending` 저장 + 디바운스 타이머 (재)설정.

**수신(흐름 있음)**: 블랙아웃 여부와 무관하게 `messages`에 저장하고 디바운스 버퍼에 넣는다. 블랙아웃은 시스템이 먼저 말을 거는 것만 막으므로, 활성 흐름의 응답은 정상 처리한다.

**인바운드 개시 예약**: `slot='inbound' AND state IN ('scheduled','fired')`인 예약. 이 검사는 흐름이 없을 때만 하므로 열린 흐름의 self 예약(slot이 `inbound`일 수 있음)과 섞이지 않는다—`close_flow`가 이미 지웠다. `fired`를 포함해야 deferred로 대기 중인 인바운드 예약이 있을 때 같은 인바운드로 흐름이 두 번 열리지 않는다.

**디바운스 만료(흐름 없음)**: `pending` 인바운드가 있고 인바운드 개시 예약이 없으면 예약 생성(`at=now`, 블랙아웃 보정—블랙아웃 중이면 그 끝, **`prompt`는 config의 `inbound_prompt`**). 블랙아웃에 받은 메시지는 아침에 인바운드 흐름으로 처리된다. 발화 시 `open_flow`가 그 시점의 모든 `pending`을 `messages`로 복사하고 `consumed`로 표시한다(§9). 다루지 않은 것도 소비된 채로 남는다.

**흐름 종료 시**: `finish()` 끝에서, 대기 인바운드가 남아 있고 인바운드 개시 예약이 없으면 새 예약 생성.

**만료(블랙아웃 진입 시)**: `received_at`이 `inbound_ttl` 초과이거나 `pending`이 `inbound_max` 초과면 오래된 것부터 `expired`. `expired`는 컨텍스트에 편입되지 않는다. 블랙아웃 중 도착한 메시지는 진입 뒤에 왔으므로 그날 만료 검사의 대상이 아니다(상한 초과분은 수신 시 오래된 것부터 `expired`).

---

## 11. 비동기 풀

**생성**: `pool_create(task, deadline, prompt)` → `pool_items` `pending`(prompt 포함) + `reservations`(`slot=deadline, prompt=그 값, payload={pool_id}`).

**마감 발화**: deadline 예약 소비 → 풀 `due`(`due_at`은 처음 한 번만) → 마감 흐름 개시(예약의 `prompt`, `origin_pool_id` 기록). 이 흐름의 self 예약은 `slot=deadline`, payload 없음. `end` reserve는 항목이 `pending`/`due`면 `slot=deadline`, `payload.pool_id=origin_pool_id`, 아니면 `main`(§5.1).

**판정**: `pool_judge(judged)` → `judged`+사유, 해당 deadline 예약 삭제. `due_keep` → `due` 유지, 예약 유지. 재검사가 필요하면 흐름이 `end` reserve를 낸다. 같은 턴에서 `judged` 후 `end` reserve를 내면 그 예약은 `main`으로 만들어진다(유령 마감 흐름 방지, §5.1). `continue`는 영향 없다.

**재발행**: `pool_create(replaces=원본)` → 원본 `reissued`, 원본 deadline 예약 삭제, 신규 `pending`.

**만료(블랙아웃 진입 시 또는 `system_catchup`)**: `created_at`이 `pool_ttl` 초과이거나 `pending+due`가 `pool_max` 초과면 오래된 것부터 `expired`. deadline 예약 삭제. 활성 흐름의 `origin_pool_id`는 제외한다.

**판정 위치**: `pool_judge`는 턴 도구이므로 어느 흐름에서든 가능.

---

## 12. 데일리 플랜

**발화**: `system_timer` → 블랙아웃 진입 → `handle_system` → (deferred·system_event 마무리 뒤) 만료 검사 → `plan_runner`.

**입력**: `plan-rules.md`, `state.md`, 이벤트 블록(날짜, 어제 미완 요약).

**출력**: `{"items": [...], "reserve": {...}|null}`. 도구 없음.

**반영**: 새 `plan_date`로 기존 행 삭제 후 삽입. `items`가 `plan_max_items` 초과면 앞에서부터 자른다. `reserve`가 있으면 첫 예약 생성.

**턴 중 조작**: `plan_done`, `plan_add`는 `TurnTx`에 모여 턴 성공 시 반영.

**하루 경계**: `last_plan_date`가 오늘이면 `system_timer`가 다음 날로 건너뛴다.

---

## 13. 정리 호출과 압축

### 13.1 정리

**발화**: 흐름 닫힘 직후 워커가 동기로 1회 시도(`run_turn` 7단계, `/pause`, 블랙아웃 규칙). 이후 재시도는 `cleanup_timer`(§8)만.

**입력**: `cleanup-rules.md`, INDEX, `state.md`, **압축된 흐름**(`flows.summary` + `id > compacted_until_id AND ignored=0`인 메시지).

**도구**: `memory_read/write/create`. `MemoryTx` commit.

**출력**: `{"done": true}`. 성공 시 `cleanup_status=done`, `cleanup_next_at=NULL`. 실패면 `pending` 유지.

**재시도**: 실패 시 `cleanup_attempts++`, `cleanup_next_at = now + min(failure_backoff_first_sec × 2^(attempts-1), failure_backoff_cap_sec)`. 큐 이벤트가 아니라 DB 값이므로 정지·흐름 활성·재시작에서 유실되지 않는다. 정지 중에 시각이 오면 실행하지 않고 `/resume` 재조준으로 이어진다. 흐름이 열려 있어도 턴 사이에 실행한다. `failure_alert_after`회 연속 실패하면 운영자 알림.

**`state.md` 갱신**: 정리 commit의 일부(같은 트랜잭션).

### 13.2 압축

**발화**: `run_turn` 8단계. 비압축 구간(`id > compacted_until_id AND ignored=0`)의 `content` 문자 수 합이 `flow_compact_chars` 초과 시.

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
- 정리 호출만 쓰기 가능. 턴은 `memory_read`로 읽기만. 플랜·압축은 도구가 없다.
- 섹션 구조와 의미는 전적으로 `cleanup-rules.md`(운영자 소유)가 규정한다.

**경로 검증**: `memory_read(name)`과 `memory_write/create(name)`은 `memory/` 하위로 정규화하고, `..` 등으로 벗어나면 거부한다. `reserve.prompt`와 `pool_create(prompt)`도 `prompts/jobs/` 하위로 검증한다.

---

## 15. 첫 실행과 재시작 복구

### 15.1 첫 실행

1. `config` 로드·zod 검증(블랙아웃 빈 값, 필수 프롬프트 파일 존재). 실패면 시작 실패.
2. DB 마이그레이션. `harness_state` 행이 없으면 §3 초기값으로 생성(`mode='paused'`).
3. 타이머는 켜지 않는다. paused 상태의 메시지에는 "`/resume`으로 시작" 안내만 보낸다(테스트 1).
4. 첫 `/resume`: `last_plan_date`가 NULL이므로 `pending_system_event=1` → `finish()`가 즉시 플랜(블랙아웃 여부 무관). 첫 플랜이 `reserve`를 내야 첫날 대화가 시작된다(§6.2).

### 15.2 재시작 복구

1. `harness_state` 읽기. `paused`면 타이머만 끄고 종료.
2. outbox 재전송: `sent_at IS NULL`이고 `ignored=0`인 assistant 메시지를 `id` 순으로 전송.
3. `cleanup_timer` 재조준(`cleanup_next_at`이 지났으면 즉시 발화). 큐에 넣지 않는다.
4. 열린 흐름이 있으면: 마지막 assistant 응답 뒤 유효 user 메시지로 디바운스 버퍼 복원, 만료 즉시(블랙아웃 무관—사용자 응답이므로).
5. **(d) 안전망**: 열린 흐름의 `pending_self_reservation_id` 행이 `fired`면 즉시 재발화(턴 도중 크래시). 행이 없고 4단계에서 버퍼도 복원되지 않았으면 **복구 self 예약**을 만든다: `at=now+min_lead`, prompt=`flows.prompt`. 실패가 아니라 프로세스 사고이므로 `failure_count`를 올리지 않고 백오프 계수도 쓰지 않는다. 흐름은 닫지 않는다.
6. `scheduled` 예약: `at` 과거면 즉시 발화(self가 아닌 것은 블랙아웃이면 밀기, self는 §9 블랙아웃 규칙), 미래면 타이머 재조정.
7. `pause_reason` 있으면 재확인 타이머.
8. `last_plan_date` 미완이면 `pending_system_event=1` 설정.
9. 흐름이 없으면 공통 마무리 `finish()`(deferred → 만료 검사·플랜). 흐름이 있고 `pending_system_event=1`이면 `system_timer`가 블랙아웃 끝(지났으면 즉시)에 `system_catchup`을 조준.

진행 중 LLM 호출은 사라진다. 그 턴은 커밋되지 않았으므로 상태·메시지·트리거 예약 삭제 모두 반영되지 않았고, 열린 흐름이면 4·5단계로 재시도된다. 커밋 뒤 전송 전에 죽었으면 2단계가 메시지를 보낸다.

---

## 16. 텔레그램 운영

- **chat_id 제한**: 설정 외 메시지는 로그 없이 버림.
- **블랙아웃**: 수신을 막지 않는다. 흐름 있으면 버퍼, 없으면 `pending` 인바운드(§10).
- **평문 전송**: `parse_mode` 미사용.
- **길이**: 4096자 초과는 줄바꿈 경계 분할.
- **다중 messages**: `send_interval` 간격. 429는 `retry_after` 대기 후 재전송.
- **403**: 남은 전송 중단, 남은 메시지는 `ignored=1, ignored_reason='undelivered'`, `/pause` 처리.
- **그 외 오류**: 몇 회 재시도 후 그 메시지는 `ignored=1, ignored_reason='undelivered'`, 로그. 상태는 이미 커밋됐으므로 그대로 진행.
- **운영 명령**: `/pause`, `/resume`, `/cancel`은 즉시 부분 + 워커 위임 부분으로 나뉜다. §9.2.

---

## 17. 확장 지점

이 하네스를 다른 용도로 쓸 때 손대는 곳.

### 17.1 새 트리거 추가

트리거는 구조적이다: `reservation_due`, `debounce_expiry`, `system_event`, `system_catchup`, `cleanup_due`, `command`. 새 종류를 추가하려면 이벤트 큐와 워커 `switch`에 분기를 넣는다. 대부분은 **예약 행으로 표현**되므로 코드 변경 없이 가능하다—`reserve.prompt`에 새 job 파일을 지정하면 된다.

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
| `blackout` | `00:00-08:00` | 시스템이 먼저 말을 걸지 않는 시간대. 자정 넘김 허용. 빈 값 금지 |
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
| 정리 동기 실행 | 다음 흐름이 백지에서 시작하지 않게 한다. 실패 시에만 `cleanup_timer`로 넘긴다 |
| `state.md` 상시 컨텍스트 | 매 턴 필요한 최소 상태를 INDEX 열람 없이 제공한다 |
| `mode`에서 `ended` 제거 | "ended"는 "흐름 없음"과 중복이다 |
| `reservations.state`(scheduled/fired) | 발화했으나 처리 못 한 예약을 타이머가 재발화하지 않게 한다. `fired`가 곧 deferred |
| `consume_random`을 LLM이 결정 | `random` 슬롯을 없앴으므로 "어느 흐름이 랜덤을 소비하는가"를 slot이 아니라 LLM의 명시적 플래그로 정한다 |
| `turn_count` 0→1 커밋에서 감소 | 실패·취소된 턴은 커밋되지 않으므로 0→1 전이는 흐름당 정확히 한 번이다. 같은 트랜잭션이라 이중 감소도 누락도 없다 |
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
| 블랙아웃은 "먼저 말 걸기"만 금지 | 활성 흐름의 응답을 버리면 대화가 끊기고, 흐름 없는 메시지를 버리면 "지속" 에이전트가 사용자의 말을 영영 무시한다. 인바운드는 §5.1 클램프로 아침에 처리된다 |
| self 예약은 블랙아웃 보정 안 함 | 보정하면 흐름이 밤새 열려 `pending_system_event`가 묶이고 플랜이 아침 이후로 밀린다. 블랙아웃 중 발화는 "응답 없으면 접는다"로 해석한다 |
| `judged`만 deadline 예약 삭제 | 판정됐는데 마감이 발화하면 유령 흐름이 열린다. `due_keep`은 아직 살아 있는 의무라 예약을 지울 이유가 없다 |
| self 예약에 payload 없음 | `pool_id` 기준 삭제(판정·만료)가 흐름 자신의 self 예약을 지워 (d)를 깨는 걸 막는다. 흐름은 `origin_pool_id`로 이미 항목을 안다 |
| `end` reserve 기본 `main` | 슬롯은 "누가 흐름을 열었나"다. 다음 일반 흐름은 `main`이 맞고, 인바운드 흐름의 후속 예약이 `inbound` 슬롯을 차지해 새 인바운드를 막던 문제가 사라진다 |
| 버퍼를 `upto_id`까지 제거 | self 턴이 버퍼의 메시지에 답한 뒤 디바운스 턴이 같은 메시지에 또 답하는 걸 막는다. 호출 중 도착한 메시지는 남긴다 |
| 트리거 예약 삭제를 `TurnTx` 안에서 | 커밋 전 크래시에 옛 self가 살아남아 (d)가 유지된다 |
| 명령은 즉시 + 워커 위임 | 정리(LLM 호출)와 흐름 개시를 `command_handler`가 하면 워커와 동시에 돈다(원칙 1 위반). 세대 카운터만 즉시 올린다 |
| `system_catchup` | 흐름이 블랙아웃을 넘겨 이어지면 플랜이 무기한 밀린다. 워커가 직렬이라 턴 사이 실행에 경합이 없다 |
| 닫힌 흐름의 미응답 메시지는 인바운드로 | LLM 호출 중 도착한 말을 흐름이 `end`로 닫히며 버리면 "지속" 에이전트가 사용자의 말을 무시하게 된다. `received_at`을 원래 시각으로 두므로 `inbound_ttl` 만료 규칙이 그대로 적용된다 |
| `close_flow`에 `upto_id` | 닫기는 4단계 커밋 안에서, 버퍼 정리는 5단계라 이미 답한 메시지가 버퍼에 남아 있다. 필터 없이 옮기면 인바운드 흐름이 같은 말에 또 답한다 |
| 인바운드 복사는 `open_flow` 한 곳 | 수신 인바운드와 `close_flow`가 옮긴 메시지가 같은 경로를 탄다. 원본은 옛 흐름 기록으로 남긴다 |
| 정리는 흐름 중에도 실행 | "흐름 중 무시 + 짧은 지연 재조준"은 큐 재순환을 부른다. 정리는 다른 흐름의 기억 쓰기라 끼어들어도 무해하다 |
| 전송 중 메시지마다 세대 비교 | 커밋 뒤의 `/cancel`·`/pause`는 3단계 비교에 걸리지 않는다. 다 보낸 뒤 지우는 것보다 멈추는 게 낫다 |
| `close_flow` 단일 연산 | 닫는 경로가 다섯이라 경로마다 적으면 빠진다. v2.2의 `/pause`가 self 행을 지우지 않아 재개 후 payload 없는 deadline 예약이 흐름을 여는 버그가 그 예다 |
| 정리 재시도를 DB + `cleanup_timer`로 | 큐 이벤트는 paused에서 버려지고 재시작에 사라진다. 다른 재시도 상태는 모두 DB에 있는데 정리만 예외였다. `finish()`에 넣으면 방금 실패한 정리를 백오프 없이 재시도한다 |
| 세대 비교를 모든 종료 경로에서 먼저 | abort는 예외로 끝나 파싱 직후 비교에 닿지 않는다. 실패 경로가 닫힐 흐름에 백오프 self를 만들고 `failure_count`를 올린다 |
| 흐름 없으면 밀린 플랜은 즉시 | 플랜은 사용자 접점이 없고 원래 블랙아웃 안에서 돈다. 플랜의 reserve는 어차피 클램프된다 |
| 공통 마무리는 루프 | 경로마다 재귀 호출하면 깊이와 재진입이 불분명해진다 |
| `turn_seq` | `/cancel`이 한 턴의 응답을 통째로 지워야 중간이 잘리지 않는다 |
| 지연 리셋·지연 시행 | 자정·단위 타이머는 재시작에 놓친다 |
| continue의 무효 prompt는 `flows.prompt`로 대체 | 재시도보다 싸고 불변식 (d)를 깨지 않는다. `end`는 흐름이 닫히므로 폐기로 충분하다 |
| 불변식을 타이머 조준으로 | "최소 1개 예약 또는 `system_timer`"는 `system_timer`가 항상 살아 있어 공허했다. 흐름이 열린 동안의 진행은 (d)가 따로 보장해야 한다 |
| 플랜·압축에 도구 없음 | 짧은 단발 호출이다. 플랜은 INDEX 대신 `state.md`를 받는다 |
| reserve·흐름 닫기까지 `TurnTx`에 포함, 전송은 커밋 뒤(outbox) | 전송과 reserve 사이 크래시로 다음 예약이 사라지는 구멍을 없앤다. 커밋 후 전송 전 크래시는 outbox 재전송으로 메워 DB 대화 기록과 사용자가 본 것이 어긋나지 않게 한다 |
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
| 3 | 블랙아웃 중 메시지(흐름 없음) | `pending` 인바운드 저장, 인바운드 예약은 블랙아웃 끝 |
| 4 | 흐름 없음 + 메시지 → 디바운스 만료 | 인바운드 예약 생성(`inbound_prompt`), 발화 시 인바운드 흐름 |
| 5 | 흐름 중 self-reserve 발화 | 턴 트리거 |
| 6 | 흐름 중 다른 slot 예약 발화 | `fired` deferred, 흐름 종료 후 처리 |
| 7 | 사용자가 self-reserve 전에 응답 | 옛 예약 삭제, 새 reserve |
| 8 | deadline 예약 + main 흐름 활성 | deferred, main 종료 후 마감 흐름 |
| 9 | `flow=end` + `reserve` 없음 | 흐름 닫힘, `system_timer` 보루 |
| 10 | 정리 실패 | `cleanup_next_at`에 백오프, `cleanup_timer`가 재시도 |
| 11 | 재시작(정리 pending) | 시작 시 재실행 |
| 12 | 재시작(디바운스 대기) | 버퍼 복원, 만료 재예약 |
| 13 | `pool_create` → 마감 발화 | `due` 전이, 마감 흐름이 `pool_items.prompt` 사용 |
| 14 | `pool_judge(judged)` | `judged`+사유, deadline 예약 삭제 |
| 15 | `pool_judge(due_keep)` + `end` reserve | `due` 유지, `slot=deadline`·`payload.pool_id` 상속한 새 예약 |
| 16 | `pool_create(replaces=원본)` | 원본 `reissued`, 원본 deadline 예약 삭제, 신규 `pending` |
| 17 | 풀 상한 초과 | 오래된 것 `expired`, deadline 예약 삭제 |
| 18 | 인바운드 상한/시간 초과 | 오래된 `pending` `expired` |
| 19 | `reserve.at` 1주 뒤 | `max_lead`로 당김 |
| 20 | `reserve.at` 30초 뒤 | `min_lead`로 밀림 |
| 21 | 파싱 실패 3회 연속 | 백오프 증가, 알림 1회, 흐름 유지 |
| 22 | `/cancel` during turn | 즉시 `turn_generation++`·abort, 워커가 흐름 닫기·정리 skip·마지막 턴 메시지 삭제·`finish()` |
| 23 | 블랙아웃 진입 + 활성 흐름 | `pending_system_event=1`, 흐름 이어짐(사용자 응답 처리). 종료 후 플랜 |
| 24 | 5000자 메시지 | 분할 전송 |
| 25 | 모델이 목록 밖 도구 호출 | 거부 결과 반환, 턴 계속 |
| 26 | `flow=end` 시 `pending_self_reservation_id` | 그 행 삭제, `end`의 reserve는 새 흐름 개시용 |
| 27 | deferred 2개 + 흐름 종료 | `at` 오름차순으로 하나씩 |
| 28 | deferred + `pending_system_event` | deferred 전부 처리 후 플랜 |
| 29 | 압축 임계 초과 | `compact` 호출, `summary`·`compacted_until_id` 갱신 |
| 30 | `/pause` + 활성 흐름 | 즉시 `turn_generation++`, 워커가 흐름 닫기·정리 실행·버퍼 `late`, 그다음 `mode=paused`. deferred 미처리 |
| 31 | `/resume` + 과거 `scheduled` | deferred 먼저, 그다음 과거 예약 즉시 발화 |
| 32 | `daily_call_limit` 도달 | `pause_reason=daily_limit`, 다음 자정까지 보류 |
| 33 | `consume_random=true` | `turn_count` 0→1 커밋에서 `random_due` 1 감소. 실패 시 미감소, 둘째 턴부터는 무시 |
| 34 | `system_event` + 활성 흐름 반복 | 큐 재순환 없음. 플래그만 |
| 35 | 재시작 + `fired`만 존재 | 복구 9단계 `finish()`에서 deferred 처리 |
| 36 | `messages` 전송 중 403 | 남은 전송 중단, `/pause` 처리 |
| 37 | 정리 입력 | `summary` + 남은 구간 |
| 38 | `pool` 20건 | 이벤트 블록에 5개 + `… 외 15건` |
| 39 | `reserve.prompt` 파일 없음 | 그 예약만 폐기, 흐름 유지, 로그 |
| 40 | 부트스트랩 세트만으로 실행 | 매일 세 번 안부를 묻는 흐름이 돈다 |
| 41 | `reserve.prompt`가 `../../etc` | 경로 검증에서 거부, 그 예약 폐기 |
| 42 | `memory_read(name="../../x")` | 거부 결과 반환 |
| 43 | continue + `reserve.prompt` 무효 | `flows.prompt`로 대체해 self 예약 생성, 흐름 유지 |
| 44 | end + `reserve.prompt` 무효 | 그 예약만 폐기, 흐름 닫힘 |
| 45 | 재시도 실패 | 백오프 예약이 `pending_self_reservation_id`로 등록 |
| 46 | deadline 흐름에서 `pool_judge(judged)` + `end` reserve | `slot=main`, payload 없음으로 생성. `continue`면 self 예약 정상 생성, 흐름 유지 |
| 47 | 이미 `due`인 항목의 deadline 재발화 | `due_at` 유지 |
| 48 | 블랙아웃 중 활성 흐름에 사용자 응답 | 디바운스 턴 정상 실행 |
| 49 | 블랙아웃 중 self 예약 발화, 대기 user 메시지 없음 | 턴 없이 흐름 닫힘(`blackout`), 정리 → 플랜 |
| 50 | 블랙아웃 중 백오프 self 예약 발화, 대기 user 메시지 있음 | 턴 실행 |
| 51 | 커밋 후 전송 전 크래시 | 재시작 시 outbox 재전송 |
| 52 | 전송 중 403 | 남은 메시지 `undelivered`, 컨텍스트에서 제외 |
| 53 | 첫 실행 | `mode=paused`, 카운터 0, 타이머 꺼짐 |
| 54 | 플랜·압축 호출 | `tools` 미제공 |
| 55 | 디바운스 대기 중 self 예약 발화 | self 턴이 메시지에 답하고 버퍼에서 제거, 디바운스 타이머 취소. 이중 응답 없음 |
| 56 | self 턴 LLM 호출 중 새 user 메시지 도착 | 커밋 후 그 메시지는 버퍼에 남아 디바운스 턴 실행 |
| 57 | 디바운스 턴 LLM 호출 중 크래시 | 옛 self 예약 생존, 재시작 시 버퍼 복원 |
| 58 | self 턴 LLM 호출 중 크래시 | 재시작 5단계에서 `fired` self 재발화 |
| 59 | 복구 후 열린 흐름에 self·버퍼 모두 없음 | 복구 self 예약(`now+min_lead`) 생성, `failure_count` 불변, 흐름 유지 |
| 60 | 블랙아웃 중 `/cancel` + `pending_system_event=1` | `finish()`에서 만료 검사·플랜 |
| 61 | `/resume` + `pending_system_event=1` | `finish()`에서 플래그 리셋 후 플랜 1회 |
| 62 | 흐름이 블랙아웃 끝까지 이어짐 | `system_catchup`으로 턴 사이 만료 검사·플랜, 흐름 유지, `origin_pool_id` 만료 제외 |
| 63 | 인바운드 흐름의 `end` reserve 뒤 새 인바운드 | reserve는 `main`, 새 인바운드 예약 정상 생성 |
| 64 | deadline 흐름 중 해당 항목 만료 시도 | `origin_pool_id`라 제외, self 예약 유지 |
| 65 | 자정 넘겨 재시작 | 첫 LLM 요청 직전 `daily_calls` 리셋 |
| 66 | deferred 3개, 각 흐름이 첫 턴에 `end` | `finish()` 루프가 차례로 처리, 재귀 없음 |
| 67 | `/cancel`, 마지막 턴이 메시지 3개 | 3개 모두 삭제 시도, 이전 턴 메시지 유지 |
| 68 | 활성 흐름 + `/pause` → `/resume` | `close_flow`가 self 행 삭제, 재개 후 유령 흐름 없음 |
| 69 | 블랙아웃 규칙으로 닫힘 후 재시작 | `fired` self 행 없음, deferred로 다시 나오지 않음 |
| 70 | `/pause` 정리 실패 → `/resume` | `cleanup_timer` 재조준, 재개 직후 재시도 |
| 71 | 정리 실패 후 바로 다음 흐름 열림 | 흐름 중 `cleanup_due` 무시, 흐름 닫힌 뒤 `finish()` 재조준으로 재시도 |
| 72 | paused 상태로 재시작 + 정리 pending | `/resume` 시 재시도 |
| 73 | 턴 중 `/cancel`로 abort(예외) | 세대 불일치로 폐기. 재시도·`failure_count`·백오프 없음 |
| 74 | 블랙아웃 중 `/resume`, 플랜 미완 | 즉시 플랜 |
| 75 | `fired` 인바운드 예약 대기 중 디바운스 만료(흐름 없음) | 새 인바운드 예약 만들지 않음 |
| 76 | 정지 상태에서 `/pause` · `/cancel` | 안내만, 세대 카운터 불변 |
| 77 | `flow=end` 턴의 LLM 호출 중 user 메시지 도착 | 원래 행 `moved`, `pending` 인바운드 생성, `finish()`가 인바운드 예약 → 인바운드 흐름이 답함 |
| 78 | 위 상황이 블랙아웃 중 | 인바운드 예약이 블랙아웃 끝으로 밀림 |
| 79 | `/cancel` 시 버퍼 메시지 | `late`, 인바운드로 옮기지 않음 |
| 80 | `flow=end` 턴, 버퍼에 `upto_id` 이하·초과 메시지 혼재 | 이하는 그대로, 초과만 인바운드로 이동. 중복 응답 없음 |
| 81 | 인바운드 흐름 개시 | `pending` 인바운드가 `messages`로 복사되어 첫 턴 컨텍스트에 들어감 |
| 82 | `moved` 메시지로 인바운드 흐름 개시 | 복사본은 새 흐름, 원본은 옛 흐름 `moved`로 유지, `source_message_id`로 연결 |
| 83 | 턴 실패 처리 중 크래시 | self 삭제·백오프 삽입이 함께 롤백, 기존 self 유지 |
| 84 | 흐름 열린 상태에서 `cleanup_due` | 턴 사이에 정리 실행 |
| 85 | 전송 도중 `/cancel` | 남은 메시지 전송 중단, `undelivered` |
| 86 | 정리·압축 입력 | `ignored=1` 메시지 제외 |
