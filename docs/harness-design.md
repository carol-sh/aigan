# 지속형 예약 에이전트 하네스 (aigan-harness) 설계 문서

> 버전: 3.0
> 상태: 구현 설계 확정. 콘텐츠(프롬프트)는 운영자 소유.
> 범위: 예약 기반으로 스스로 깨어나 사용자와 상호작용하는 지속형 에이전트 하네스. 프롬프트 내용은 이 문서의 범위 밖이며, §6의 콘텐츠 계약을 따른다.
> 전제: 개인 서버 설치형, 단일 사용자. 텔레그램 FE. 운영자 = 사용자.

**3.0 변경 요약** (2.x 이력은 git 기록과 `harness-trace.md` 참고)
- **운영 명령(`/pause`·`/resume`·`/cancel`) 제거.** 일시정지는 프로세스 정지로, 흐름 중단은 대화로("그만" → LLM이 `flow=end`), 초기화는 프로세스 밖에서 도는 `aigan reset` CLI로 한다. 그 결과 `mode`, `turn_generation`, LLM 호출 abort, `command` 이벤트, `turn_seq`, `tg_message_id`가 사라지고 원칙 1(워커만 상태를 바꾼다)이 예외 없이 성립한다.
- **보류(hold)를 워커 게이트로.** 잔액 부족·일일 상한·사용자 차단(403)은 모두 보류다. 보류 중 이벤트는 소비하지 않고 DB 흔적만 남기며, 해제는 재시작과 같은 `resume()` 절차를 탄다(§9.6).
- **미응답 판정을 DB로.** `flows.answered_upto_id`를 두고 디바운스 버퍼를 메모리 대신 DB에서 계산한다. 메시지 없는 턴 뒤의 재응답·블랙아웃 오판 수정.
- **`main` 개시 예약은 하나.** 새로 만들면 기존 것을 교체. 이벤트 블록에 다음 `main` 예약을 노출.
- **계획일(plan key) 정의.** 블랙아웃 끝 시각의 로컬 날짜. 자정을 넘는 블랙아웃의 플랜 중복·누락 수정. `pending_system_event`·`system_catchup`을 "계획일이 밀렸는가"라는 파생 조건과 `system_due` 이벤트 하나로 통합.
- **플랜 실패 재시도**(`plan_retry_at`), **deferred의 블랙아웃 재예약**, **개시 전 사전 검사**, **낡음 기준**(`stale_after_sec`).

---

## 1. 개요와 원칙

### 1.1 이 하네스가 하는 일

에이전트가 **정해진 시각에 스스로 깨어나** 사용자에게 말을 걸고, 사용자의 응답을 받아 대화를 이어가고, 다음에 언제 깨어날지를 스스로 정하는 하네스다. 대화는 흐름(flow) 단위로 열리고 닫히며, 닫힐 때 기억 쓰기 호출이 돈다. 비동기 작업은 별도 풀에서 마감과 함께 관리되고, 하루 단위 계획이 블랙아웃(사용자가 자는 시간)에 그려진다.

프롬프트 파일을 교체하면 비서, 코치, 튜터, 저널링 봇, 리마인더 등으로 용도가 바뀐다. 하네스는 그 파일들이 무엇을 하는지 모른다.

### 1.2 원칙

1. **직렬성은 구조로 보장한다.** 상태를 바꾸는 것은 워커 하나뿐이다. 수신 핸들러는 메시지 행을 쓰고 디바운스 타이머를 건드릴 뿐이고, 타이머는 큐에 이벤트를 넣을 뿐이다.
2. **불변식은 하네스가 강제한다.** 타이머 조준, 활성 흐름 최대 1개, 열린 흐름의 다음 턴 예약, 슬롯별 개시 예약 단일성, 블랙아웃에 먼저 말 걸지 않음(§8)은 프롬프트 부탁이 아니라 코드다.
3. **나머지는 LLM 재량이다.** 무엇을 시킬지, 어떻게 판정할지, 언제 다시 깨어날지, 언제 대화를 접을지는 하네스가 관여하지 않는다.
4. **읽기는 즉시, 쓰기는 트랜잭션.** 도구의 읽기는 결과를 바로 돌려주고, 상태 변경은 턴 성공 시 일괄 반영한다.
5. **큐는 휘발성, 진실은 DB.** 모든 큐 이벤트는 DB 상태에서 다시 만들어질 수 있다. 재시작·보류 해제는 DB만 보고 이어간다.
6. **하네스는 콘텐츠를 모른다.** 예약 행의 `prompt`는 파일 경로이고, 하네스는 그 파일을 읽어 컨텍스트에 넣을 뿐이다.

### 1.3 용어

| 용어 | 뜻 |
|---|---|
| **흐름** (flow) | 사용자와 접점을 갖는 상호작용의 단위. 열림과 닫힘이 있고, 여러 턴을 포함한다. 활성 흐름은 최대 1개 |
| **턴** (turn) | 흐름 안의 한 사이클. LLM 호출 한 번(도구 라운드 포함) + 결과 반영 |
| **예약** (reservation) | 미래의 발화 시각을 담은 행 |
| **self 예약** | 열린 흐름의 다음 턴 예약. `flows.pending_self_reservation_id`가 가리키는 행 |
| **개시 예약** | self 예약이 아닌 모든 예약. 발화하면 새 흐름을 연다 |
| **슬롯** (slot) | 개시 예약의 네임스페이스. `main` / `inbound` / `deadline`. "누가 흐름을 열었나"를 뜻한다 |
| **prompt** | 예약·흐름이 사용하는 프롬프트 파일 경로 |
| **reserve** | LLM 출력의 다음 예약 필드 |
| **미응답** | 열린 흐름의 user 메시지 중 `id > flows.answered_upto_id`이고 `ignored=0`인 것. 디바운스 버퍼의 정의 |
| **deferred** | 발화했으나 처리하지 못한 개시 예약. `state='fired'` |
| **시스템 작업** | 사용자 접점이 없는 일 — 만료 검사, 플랜, 정리, 압축 |
| **블랙아웃** | 시스템이 **먼저** 말을 거는 것이 금지되는 시간대. 활성 흐름에서 미응답에 답하는 것은 허용 |
| **계획일** (plan key) | 블랙아웃 끝 시각의 로컬 날짜. 그 블랙아웃에 그리는 플랜이 계획하는 날(§8.2) |
| **보류** (hold) | LLM 호출을 할 수 없는 상태. `balance` / `daily_limit` / `blocked`(§9.6) |
| **INDEX** | `memory/*.md`의 `description` frontmatter에서 생성되는 목록 |
| **인바운드** | 흐름이 없을 때 사용자가 보낸 메시지. `inbound_messages` |
| **플랜** | 블랙아웃에 그리는 하루 계획. `plan_items` |
| **비동기 풀** | 마감이 있는 작업 목록. `pool_items` |
| **압축** | 현재 흐름 대화가 임계를 넘으면 오래된 부분을 요약으로 대체하는 것 |
| **outbox** | `sent_at IS NULL AND ignored=0`인 assistant 메시지 |
| **낡음** (stale) | 발생 시각이 `now - stale_after_sec`보다 이른 것 |
| **`DATA_DIR`** | 설정·프롬프트·기억 파일·DB가 사는 디렉터리 |
| **`TurnTx`** | 한 턴의 모든 상태 변경을 모으는 트랜잭션. 최종 JSON 성공 시 commit |
| **`MemoryTx`** | 정리 호출의 기억 쓰기를 모으는 트랜잭션 |

---

## 2. 전체 구조

```
텔레그램 (롱폴링)
    │
    ▼
receive_handler ─ chat_id 검사 · 메시지 행 기록 · 디바운스 타이머 (재)설정
                                                    │ (만료)
flow_timer    (MIN reservations.at WHERE scheduled) ─┤
system_timer  (system_due가 가능해지는 시각)        ─┼─▶ event_queue ─▶ worker ─▶ turn / plan / cleanup / compact
cleanup_timer (MIN flows.cleanup_next_at)           ─┤
hold_timer    (harness_state.hold_until)            ─┘

aigan reset (CLI, 프로세스 정지 상태에서만) ─▶ DB
```

**참조 구현 스택**: Node 24 + TypeScript(타입 제거 실행), SQLite(`node:sqlite`), grammY(텔레그램), openai SDK 호환 클라이언트, luxon(시간대), zod(검증).

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
├── aigan.db
└── aigan.lock              # 단일 인스턴스 잠금(§15)
```

---

## 3. 전역 상태

`harness_state`는 행 1개다.

| 필드 | 값 | 의미 |
|---|---|---|
| `current_flow_id` | INTEGER / NULL | 열려 있는 흐름 |
| `hold_reason` | NULL / `balance` / `daily_limit` / `blocked` | 보류 사유(§9.6) |
| `hold_until` | TEXT / NULL | 보류 재확인 시각. `blocked`는 NULL |
| `random_due` | INTEGER | 랜덤 이벤트 대기 수 |
| `last_roll_at` | TEXT / NULL | 마지막 주사위 시각 |
| `last_plan_date` | TEXT / NULL | 마지막으로 완료한 계획일 |
| `plan_attempts` | INTEGER | 현재 계획일의 플랜 실패 횟수 |
| `plan_retry_at` | TEXT / NULL | 플랜 재시도 시각 |
| `failure_count` | INTEGER | 턴 연속 실패 |
| `daily_calls` | INTEGER | 오늘 LLM 요청 수 |
| `daily_calls_date` | TEXT / NULL | 카운트 기준 로컬 날짜 |

**초기값**: `current_flow_id`·`hold_reason`·`hold_until`·`last_roll_at`·`last_plan_date`·`plan_retry_at`·`daily_calls_date` NULL, 나머지 0. 정지 모드는 없다—설정 검증을 통과하면 바로 동작한다.

**파생 상태**

| 이름 | 조건 |
|---|---|
| 보류 | `hold_reason IS NOT NULL` |
| 흐름 없음 | `current_flow_id IS NULL` |
| 흐름 있음 | `current_flow_id IS NOT NULL` |
| 플랜 밀림 | `last_plan_date IS NULL OR last_plan_date < 현재 계획일`(§8.2) |

**`random_due`**
- 발생: `random_unit_sec`마다 확률 `random_prob`로 1 증가, `random_max_due` 상한. **지연 시행**: 워커가 이벤트를 처리하기 직전에 `last_roll_at` 이후 지난 단위 수만큼 굴리고 `last_roll_at`을 그만큼 전진시킨다.
- 감소: 흐름의 첫 턴(`turn_count` 0→1 커밋)에서 `consume_random=true`면 같은 `TurnTx`에서 1 감소(하한 0). 첫 턴에서 false면 그 흐름은 이후 감소하지 않는다.

**`daily_calls`** — LLM API 요청 1건마다 1 증가(도구 라운드 포함). **지연 리셋**: 요청 직전에 `daily_calls_date`가 오늘(로컬)이 아니면 0으로 리셋.

---

## 4. 이벤트 처리 표

큐 이벤트는 다섯: `debounce_expiry`, `reservation_due(id)`, `system_due`, `cleanup_due`, `hold_check`. 모두 DB 상태에서 다시 만들어질 수 있다.

| 이벤트 | 보류 중 | 흐름 없음 | 흐름 있음 |
|---|---|---|---|
| `debounce_expiry` | `blocked`면 해제 → `resume()`. 그 외 무시(미응답·인바운드는 DB에 남음) | 대기 인바운드가 있고 인바운드 개시 예약이 없으면 생성(§10). 아니면 무시 | 미응답이 있으면 디바운스 턴. 없으면 무시 |
| `reservation_due(id)` | 무시. 행은 `fired`로 남는다 | 행 없음 → 폐기. 블랙아웃이면 끝으로 재예약. 아니면 게이트 → 사전 검사 → `open_flow` → 첫 턴 | self면 턴(블랙아웃 중이면 §9.3 규칙). 개시 예약이면 `fired` 유지(deferred) |
| `system_due` | 무시 | 플랜 밀림이고 재시도 시각 도래 → 게이트 → 만료 검사 → 플랜 | 같은 조건 + 현재 계획일의 블랙아웃이 끝났을 때만 실행(턴 사이). 아니면 무시 |
| `cleanup_due` | 무시 | `cleanup_next_at <= now`인 pending 흐름 하나 정리 | 같음 |
| `hold_check` | 해제 조건 확인 → 해제 시 `resume()` | 해당 없음 | 해당 없음 |

"무시"는 상태를 바꾸지 않는다는 뜻이다. 필요한 일은 DB에 남은 흔적(`fired`, 미응답, 플랜 밀림, `cleanup_next_at`)으로 나중에 다시 발견된다.

---

## 5. 상태 전이

### 5.1 예약 (`reservations`)

| 컬럼 | 타입 | 비고 |
|---|---|---|
| `id` | INTEGER PK | 교체 시 새 id |
| `at` | TEXT | ISO 8601 + offset |
| `slot` | TEXT | `main` / `inbound` / `deadline` |
| `prompt` | TEXT | `prompts/jobs/` 하위 경로 |
| `state` | TEXT | `scheduled` / `fired`. `scheduled`만 타이머가 조준 |
| `memo` | TEXT / NULL | 다음 호출에 남기는 한 줄 |
| `payload` | TEXT / NULL | deadline 개시 예약이면 `{"pool_id":N}`. 그 외 NULL |
| `created_at` | TEXT | |

**생성 원천**

| 원천 | 종류 | slot | payload |
|---|---|---|---|
| 턴 `continue` reserve | self | 흐름의 `origin_slot` | NULL |
| 턴 실패 백오프 | self | 흐름의 `origin_slot` | NULL |
| 복구 self(§9.5) | self | 흐름의 `origin_slot` | NULL |
| 턴 `end` reserve | 개시 | 기본 `main`. deadline 흐름이고 `origin_pool_id` 항목이 `pending`/`due`면(`TurnTx` 반영 후 기준) `deadline` | `deadline`이면 `{"pool_id": origin_pool_id}` |
| 플랜 reserve | 개시 | `main` | NULL |
| `pool_create` | 개시 | `deadline` | `{"pool_id": 새 id}` |
| 인바운드 | 개시 | `inbound` | NULL |

`reserve`에는 slot이 없다. 위 표대로 하네스가 정한다.

**개시 예약 단일성**(불변식 (e))
- `main`: 최대 1개(`scheduled`·`fired` 합산). 새로 만들면 기존 `main` 개시 예약을 삭제한다. 플랜·`end` reserve 중 나중 것이 이긴다. reserve가 null이면 기존 것을 건드리지 않는다.
- `inbound`: 최대 1개. 이미 있으면 만들지 않는다.
- `deadline`: `pool_id`당 최대 1개. 새로 만들면 같은 `pool_id`의 기존 개시 예약을 삭제한다.

**클램프 (생성 시)**

| 원천 | `at` 규칙 |
|---|---|
| 개시 예약(`end`·플랜 reserve) | `clamp(now+min_lead, now+max_lead)`, 블랙아웃이면 그 끝으로 |
| self 예약(`continue`·백오프·복구) | `clamp(now+min_lead, now+max_lead)`. 블랙아웃 보정 안 함(§9.3) |
| `pool_create` | `deadline` 그대로. 과거면 `now+min_lead`, `now+pool_ttl` 초과면 거부. 블랙아웃이면 그 끝으로 |
| 인바운드 | `now`. 블랙아웃이면 그 끝으로 |

**prompt 결정**
- 턴 reserve: `reserve.prompt`. 무효(`prompts/jobs/` 밖, 파일 없음·읽기 불가)면 `continue`는 `flows.prompt`로 대체, `end`는 그 예약만 폐기. 로그.
- 백오프 self: 실패한 턴의 프롬프트. 복구 self: `flows.prompt`.
- 플랜 reserve: `reserve.prompt`. 무효면 폐기.
- `pool_create`: 인자 `prompt`(검증 실패 시 도구 거부). 인바운드: config `inbound_prompt`.

| 전이 | 조건 |
|---|---|
| 생성 | 위 원천. `state='scheduled'` |
| 발화 | `flow_timer` → `state='fired'`, `reservation_due(id)` 큐 투입 |
| 소비(개시) | `open_flow`에서 행 삭제 |
| 소비(self) | 그 턴의 `TurnTx`에서 행 삭제. 실패·크래시면 남는다 |
| deferred | 개시 예약이 흐름 있을 때·보류 중 발화. `fired` 유지 |
| 재예약 | deferred 처리 시 블랙아웃이면 `state='scheduled'`, `at=블랙아웃 끝`(§9.4) |
| 삭제 | 단일성 교체, `close_flow`(self), 풀 판정·재발행·만료(deadline), 사전 검사 실패, reset |

### 5.2 흐름 (`flows`)

| 컬럼 | 타입 | 비고 |
|---|---|---|
| `id` | INTEGER PK | |
| `origin_slot` | TEXT | 흐름을 연 예약의 slot. self 예약의 slot |
| `origin_reservation_id` | INTEGER | 기록용 |
| `origin_pool_id` | INTEGER / NULL | deadline 흐름이면 개시 예약의 `payload.pool_id` |
| `pending_self_reservation_id` | INTEGER / NULL | self 예약 id |
| `prompt` | TEXT | 마지막 성공 턴의 프롬프트. 개시 시 개시 예약의 prompt |
| `turn_count` | INTEGER | 커밋된 턴 수 |
| `answered_upto_id` | INTEGER | 마지막 커밋된 턴이 컨텍스트에 넣은 user 메시지의 최대 id. 개시 시 0 |
| `started_at` / `ended_at` | TEXT | |
| `end_reason` | TEXT / NULL | `agent` / `blackout` / `stale` / `reset` |
| `cleanup_status` | TEXT / NULL | `pending` / `done` / `skipped` |
| `cleanup_next_at` | TEXT / NULL | 다음 정리 시도 시각 |
| `cleanup_attempts` | INTEGER | |
| `summary` | TEXT / NULL | 압축 요약 |
| `compacted_until_id` | INTEGER / NULL | 압축이 커버한 마지막 message id |

| 전이 | 조건 |
|---|---|
| 열림 | `open_flow`(§9.2) |
| 턴 | 커밋 시 `turn_count++`, `prompt`·`answered_upto_id`·`pending_self_reservation_id` 갱신 |
| 압축 | 턴 뒤 임계 초과 시 `summary`·`compacted_until_id` 갱신 |
| 닫힘 | `close_flow(reason)`(§9.2). `agent`(LLM `flow=end`), `blackout`(§9.3), `stale`(§9.5), `reset`(§15.3) |
| 정리 | 성공 `done`, 실패 `cleanup_attempts++`·`cleanup_next_at` 백오프 |

### 5.3 비동기 풀 (`pool_items`)

| 컬럼 | 타입 | 비고 |
|---|---|---|
| `id` | INTEGER PK | |
| `task` | TEXT | |
| `deadline` | TEXT | |
| `prompt` | TEXT | 마감 흐름의 프롬프트 |
| `state` | TEXT | `pending` / `due` / `judged` |
| `close_reason` | TEXT / NULL | `judged` / `reissued` / `expired` / `cancelled` |
| `created_at` | TEXT | |
| `due_at` | TEXT / NULL | 처음 `due`가 된 시각 |

| 전이 | 조건 |
|---|---|
| `pending` | `pool_create` |
| `due` | deadline 개시 예약으로 흐름이 열릴 때. `due_at`은 NULL일 때만 기록 |
| `judged` | `pool_judge(judged)`, 재발행(`reissued`), 만료(`expired`), reset(`cancelled`) |
| `due` 유지 | `pool_judge(due_keep)`. 예약은 건드리지 않는다 |

**`judged`로 닫힐 때**(사유 무관) 그 `pool_id`의 deadline 개시 예약(`scheduled`·`fired`)을 삭제한다. self 예약은 payload가 없으므로 영향받지 않는다.

### 5.4 인바운드 (`inbound_messages`)

`id`, `content`, `received_at`, `status`(`pending`/`consumed`/`expired`), `consumed_at`, `consumed_flow_id`, `source_message_id`(`close_flow`가 옮긴 원본 `messages.id`, 아니면 NULL).

| 전이 | 조건 |
|---|---|
| `pending` | 흐름 없을 때 수신(블랙아웃 무관), 또는 `close_flow`가 미응답을 옮김 |
| `consumed` | `open_flow`(inbound)가 `messages`로 복사 |
| `expired` | 만료 검사, reset |

### 5.5 플랜 (`plan_items`)

`id`, `text`, `hint`, `done`(0/1), `created_at`, `plan_date`(계획일).

| 전이 | 조건 |
|---|---|
| 생성·교체 | 플랜 성공 시 그 계획일의 행으로 전체 교체. 이전 계획일 행은 삭제 |
| 체크 / 추가 | `plan_done(id)` / `plan_add(text, hint?)`. 현재 계획일 행만 대상 |

### 5.6 메시지 (`messages`)

`id`, `flow_id`, `role`(`user`/`assistant`), `content`, `ts`, `ignored`(0/1), `ignored_reason`(`moved`/`undelivered`/`reset`), `sent_at`(assistant만, NULL=미전송).

- **흐름 메시지를 읽는 모든 곳**(턴 컨텍스트, 미응답 계산, 정리 입력, 압축 대상·임계)은 `ignored=0`만 본다.
- **outbox**: assistant 메시지는 `TurnTx`에서 `sent_at=NULL`로 저장되고, 전송 성공마다 `sent_at`을 채운다.
- **이벤트 블록은 저장하지 않는다.** 컨텍스트 조립 시 마지막 user 메시지에 합쳐질 뿐이다.

### 5.7 LLM 호출 로그 (`llm_calls`)

`id`, `kind`(`turn`/`cleanup`/`plan`/`compact`), `flow_id`, `request`, `response`, `input_tokens`, `cached_tokens`, `output_tokens`, `latency_ms`, `success`, `created_at`. 인덱스: `created_at`, `kind`.

---

## 6. 컨텍스트 조립과 콘텐츠 계약

### 6.1 턴 호출 조립

| # | role | 내용 | 출처 |
|---|---|---|---|
| 1 | system | persona | `prompts/persona.md`(있으면) |
| 2 | system | call-rules | `prompts/call-rules.md`(필수, 플레이스홀더 치환) |
| 3 | system | state | `memory/state.md`(있으면) |
| 4 | system | INDEX | §6.4 |
| 5 | system | job prompt | self 트리거면 그 예약의 `prompt`, 디바운스 트리거면 `flows.prompt` |
| 6 | user/assistant | 현재 흐름 대화 | `messages WHERE flow_id=? AND ignored=0 AND id > COALESCE(compacted_until_id,0)`. `summary`가 있으면 앞에 요약 블록. assistant는 JSON 원문 |
| 7 | user | 이벤트 블록 | 하네스 |

- 6번의 마지막 user 메시지와 7번은 하나의 user 메시지로 합친다. 6번이 assistant로 끝나면(self 트리거) 7번이 단독 user 메시지가 된다.
- 사진·파일은 `[사진]`/`[파일]` 표시만 남긴다.

### 6.2 콘텐츠 계약

| 파일 | 필수 | 로드 시점 | 없으면 |
|---|---|---|---|
| `prompts/persona.md` | 선택 | 매 턴 | 건너뜀 |
| `prompts/call-rules.md` | **필수** | 매 턴 | 시작 실패 |
| `prompts/plan-rules.md` | 플랜 사용 시 | 플랜 호출 | 플랜 비활성(만료 검사만, §12) |
| `prompts/cleanup-rules.md` | 정리 사용 시 | 정리 호출 | 닫힐 때 `skipped` |
| `prompts/compact-rules.md` | 압축 사용 시 | 압축 호출 | 압축 비활성 |
| `prompts/jobs/*.md` | `inbound_prompt` 포함 최소 1개 | 예약의 `prompt` | `inbound_prompt` 없으면 시작 실패. 그 외는 그 예약 폐기 |
| `memory/state.md` | 선택 | 매 턴·플랜·정리 | 건너뜀 |
| `memory/*.md` | 선택 | INDEX만 | INDEX 생략 |

**운영자가 콘텐츠로 정해야 하는 것**
- `call-rules.md`: 출력 스키마, 도구, 이벤트 블록 읽는 법, reserve 규칙. **사용자가 그만하자고 하면 `flow=end`를 내라**(명령어가 없으므로 흐름 중단은 대화로 한다).
- `plan-rules.md`: 플랜 `reserve`가 null이면 다음 블랙아웃까지 하네스가 먼저 말을 걸지 않는다. 특히 첫 플랜은 reserve를 내도록 규정한다.

**플레이스홀더**(단순 문자열 치환, 모르는 것은 그대로 둔다)

| 플레이스홀더 | 값 |
|---|---|
| `{now}` | 현재 ISO8601 |
| `{timezone}` | 설정의 IANA 이름 |
| `{today}` | 현재 로컬 날짜 |
| `{plan_date}` | 현재 계획일(§8.2) |
| `{blackout_start}` / `{blackout_end}` | 다음(또는 진행 중인) 블랙아웃의 시작/끝 |
| `{min_lead_sec}` / `{max_lead_sec}` | 예약 클램프 범위 |
| `{plan_max_items}` / `{pool_max_pending}` | 상한 |

**이벤트 블록**

```
[event]
now: <ISO8601>
prompt: <이번 턴의 job prompt 경로>
memo: <트리거 예약의 memo 또는 (없음)>
next_main: <at> <prompt> | (없음)
random_due: <int>
inbound_pending: <int>
pool_focus:
  #<id> <state> "<task>" (<deadline>)        ← origin_pool_id가 있을 때만
pool:
  - #<id> <state> "<task>" (<deadline>, <상대시간>)
  … 외 <N>건
plan (<plan_date>):
  [ ] #<id> <text> — <hint>
  [x] #<id> <text> — <hint>
```

- `memo`: self 트리거면 그 예약의 memo. 디바운스 트리거면 대기 중이던 self 예약의 memo(커밋 전이므로 읽을 수 있다).
- `next_main`: `main` 개시 예약(최대 1개). LLM이 `end` reserve로 이것을 교체한다는 것을 알 수 있게 한다.
- `pool`: `pending`·`due` 중 최대 5개. `due` 먼저(`deadline` 오름차순), 그다음 `pending`. 비면 줄 생략. `pool_focus`는 상한 미포함.
- `plan`: 현재 계획일 항목. 없으면 `plan: (없음)`.

### 6.3 시스템 작업 조립

| 호출 | 블록 | 도구 |
|---|---|---|
| 플랜 | `plan-rules.md` + `state.md` + 이벤트 블록(계획일, 전 계획일 미완 항목) | 없음 |
| 정리 | `cleanup-rules.md` + INDEX + `state.md` + (`summary` + `id > compacted_until_id AND ignored=0` 메시지) | `memory_read/write/create` |
| 압축 | `compact-rules.md` + 기존 `summary` + 압축 대상 구간 | 없음 |

persona·call-rules는 시스템 작업에 넣지 않는다.

### 6.4 INDEX 생성

`memory/*.md` 중 `state.md`를 뺀 파일을 파일명 사전순으로, `description` frontmatter(없으면 파일명만)와 함께 나열.

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

- `messages`: 0개 이상. 0개여도 `answered_upto_id`는 갱신된다(답하지 않기로 한 것도 처리다).
- `flow=continue`면 `reserve` 필수, `end`면 선택.
- `consume_random`: 선택, 기본 false. 첫 턴에서만 의미가 있다.

플랜: `{"items": [{"text": "string", "hint": "string | null"}], "reserve": {...} | null}`.
정리: `{"done": true}`. 압축: `{"summary": "string"}`. `response_format: json_object`.

### 7.2 도구

| 도구 | 인자 | 노출 |
|---|---|---|
| `memory_read` | `name` | 턴, 정리 |
| `memory_write` | `name`, `content` | 정리 |
| `memory_create` | `name`, `description`, `content` | 정리 |
| `pool_judge` | `id`, `verdict: "judged" \| "due_keep"` | 턴 |
| `pool_create` | `task`, `deadline`, `prompt`, `replaces?` | 턴 |
| `plan_done` | `id` | 턴 |
| `plan_add` | `text`, `hint?` | 턴 |

**검증**(실패 시 거부 결과를 돌려주고 턴은 계속)
- `pool_judge`: 없는 id·이미 `judged`면 거부.
- `pool_create`: `prompt`가 `prompts/jobs/` 하위가 아니거나 없으면 거부. `replaces`가 없거나 `judged`면 거부. `replaces` 없이 `pending+due >= pool_max_pending`이면 거부. `replaces`가 `pending`/`due`면 원본 `reissued`.
- `plan_done`: 현재 계획일에 없는 id면 거부. `plan_add`: 현재 계획일 항목이 `plan_max_items` 이상이면 거부.
- `memory_create`: `memory_max_files` 이상이면 거부. `memory_write`: `memory_file_max_chars` 초과면 거부.
- 모든 `name`·`prompt` 경로는 정규화 후 `memory/`·`prompts/jobs/` 하위가 아니면 거부.
- 목록에 없는 도구 호출은 거부.

### 7.3 파싱·실패

| 상황 | 처리 |
|---|---|
| JSON 파싱·스키마 실패, `continue`인데 `reserve` 없음, `at` 형식 오류 | 1회 재시도 |
| `reserve.prompt` 무효 | §5.1 prompt 결정 |
| `at` 범위 밖 | 클램프 |
| 재시도도 실패, 또는 네트워크·5xx 등 예외 | **턴 실패**(§9.4 9단계) |

**백오프 공식**(턴·정리·플랜 공통): `backoff(n) = min(failure_backoff_first_sec × 2^(n-1), failure_backoff_cap_sec)`. `n`이 `failure_alert_after`에 처음 도달하면 운영자 알림(로그 + 보류가 `blocked`가 아니면 텔레그램).

### 7.4 도구 라운드

- 최대 `max_tool_rounds`(정리는 `max_cleanup_tool_rounds`)회 반복 후 최종 JSON. 상한 초과 시 `tools` 유지 + `tool_choice: "none"`으로 한 번 더 호출.
- 도구 쓰기 효과는 `TurnTx`/`MemoryTx`에 모았다가 최종 JSON 성공 시 commit.

---

## 8. 시간: 블랙아웃·계획일·타이머·불변식

### 8.1 블랙아웃

설정 `blackout = HH:MM-HH:MM`(자정 넘김 허용, 빈 값 금지). 로컬 시간대 기준으로 매일 하나의 구간 `[start, end)`가 생긴다. DST로 시각이 없거나 두 번 있는 경우는 luxon의 기본 보정을 따른다.

- **개시 예약**은 블랙아웃에 발화하지 않는다. 생성 시 끝으로 밀고, 발화 시점·deferred 처리 시점에 다시 확인해 끝으로 재예약한다.
- **self 예약**은 블랙아웃 보정을 받지 않는다. 블랙아웃 중 발화는 §9.3 규칙을 따른다.
- 수신은 블랙아웃과 무관하다(§10).

### 8.2 계획일

- 블랙아웃 구간 `B`의 **계획일** = `B.end`의 로컬 날짜.
- **현재 계획일** = 이미 시작된(`start <= now`) 가장 최근 블랙아웃의 계획일.
- **플랜 밀림** = `last_plan_date IS NULL OR last_plan_date < 현재 계획일`.

예: `00:00-08:00`이면 D일 00:00 진입의 계획일은 D. `23:00-07:00`이면 D일 23:00 진입의 계획일은 D+1이고, D+1일 01:00·15:00의 현재 계획일도 D+1이다. 그래서 재시작해도 중복되지 않고, D+1일 23:00 진입(계획일 D+2)에서 다시 밀린다.

### 8.3 타이머

**재조준 일반 규칙**: 모든 타이머는 자기 조준식의 입력이 바뀌는 쓰기 직후 재조준한다. 지난 시각이면 즉시 발화한다.

| 타이머 | 조준 | 발화 |
|---|---|---|
| `flow_timer` | `MIN(at) WHERE state='scheduled'` | `state='fired'` + `reservation_due(id)` |
| `system_timer` | `system_due`가 실행 가능해지는 가장 이른 시각(아래) | `system_due` |
| `cleanup_timer` | `MIN(cleanup_next_at) WHERE cleanup_status='pending'` | `cleanup_due` |
| `hold_timer` | `hold_until`(보류 중이고 NULL이 아닐 때) | `hold_check` |
| 디바운스 | 마지막 수신 + `message_debounce_sec` | `debounce_expiry` |

**`system_timer` 조준**
- 플랜이 밀리지 않았으면: 다음 블랙아웃 시작.
- 밀렸으면 `MAX(조건들)`: `plan_retry_at`(있으면), 그리고 흐름이 열려 있으면 현재 계획일 블랙아웃의 끝. 조건이 없으면 지금.

보류 중에도 타이머는 돈다(발화는 흔적만 남긴다). `flow_timer` 발화가 행을 `fired`로 바꾸는 것도 그대로 둔다.

### 8.4 불변식

| # | 내용 |
|---|---|
| (a) | `system_timer`는 항상 무장돼 있다 |
| (b) | `scheduled` 행이 있으면 `flow_timer`는 `MIN(at)`을 조준한다 |
| (c) | 활성 흐름은 최대 1개 |
| (d) | 열린 흐름은 턴 실행 중이 아니면 self 예약 행을 가진다(`scheduled`, 또는 보류·처리 대기로 `fired`) |
| (e) | 개시 예약은 `main` ≤ 1, `inbound` ≤ 1, `deadline`은 `pool_id`당 ≤ 1 |

"멈춤 없음"은 (a)+(d)와 `hold_timer`에서 나온다. 흐름이 없으면 (a)가 늦어도 다음 블랙아웃에 깨우고, 흐름이 있으면 (d)의 self 예약이 턴을 돌리거나 흐름을 닫는다. 보류는 `hold_timer`가 풀고, `blocked`만은 사용자의 다음 메시지가 푼다.

---

## 9. 워커

### 9.1 루프와 게이트

```
loop:
  event = queue.pop()
  roll_random()
  if hold_reason:
    if event == hold_check: try_release()                       # §9.6
    elif event == debounce_expiry and hold_reason == 'blocked': release(); resume()
    continue                                                    # 나머지는 흔적만 남기고 무시
  dispatch(event)                                               # §4 표
  if 이번 이벤트에서 흐름이 닫혔음: finish()
```

**LLM 게이트** `gate()`: LLM을 부르기 직전에 확인한다. 실패하면 보류에 들어가고(§9.6), 현재 핸들러는 **아무 상태도 바꾸지 않고** 끝난다.
- 게이트는 상태를 바꾸기 **전에** 둔다. 개시 예약은 `open_flow` 전, 턴은 컨텍스트 조립 전, 플랜은 만료 검사 전, 정리·압축은 호출 전.
- 확인 내용: `daily_calls < daily_call_limit`, `provider=deepseek`면 잔액 `>= balance_threshold`(통화 로그, 불일치 시 경고 후 비교). `openai`는 잔액 확인 없음.
- 일일 상한은 턴 단위로 판정한다. 턴 중 도구 라운드로 상한을 넘는 것은 허용한다.

### 9.2 흐름 연산

**사전 검사** `precheck(r)` — 개시 예약을 열기 전. 실패하면 행을 삭제하고 로그만 남긴다.
- `prompt` 파일이 읽히지 않음.
- `slot='inbound'`인데 `pending` 인바운드가 0건.
- `slot='deadline'`인데 풀 항목이 `pending`/`due`가 아님.

**`open_flow(r)`** — 한 트랜잭션.
1. `r` 삭제. `flows` 생성(`origin_*`, `prompt=r.prompt`, `turn_count=0`, `answered_upto_id=0`). `current_flow_id` 설정.
2. `deadline`: 풀 항목 `due`(`due_at`은 처음만), `origin_pool_id` 기록.
3. `inbound`: `pending` 인바운드 전부를 `id` 순으로 `messages`에 복사(`role='user'`, 새 흐름, `ts=received_at`)하고 `consumed` 표시.

**`close_flow(reason)`** — 흐름을 닫는 유일한 연산. 한 트랜잭션(턴 안이면 그 `TurnTx`).
1. self 예약 행 삭제(`scheduled`·`fired` 무관).
2. `ended_at`, `end_reason`.
3. `cleanup_status`: `reset`이거나 `cleanup-rules.md`가 없으면 `skipped`(최종, 소급 없음). 아니면 `pending`, `cleanup_next_at=now`, `cleanup_attempts=0`.
4. 미응답(`id > answered_upto_id`, `role='user'`, `ignored=0`)을 `inbound_messages`에 `pending`으로 복사(`received_at=ts`, `source_message_id`)하고 원본은 `ignored=1, ignored_reason='moved'`. `reset`이면 복사하지 않고 `ignored_reason='reset'`.
5. `current_flow_id=NULL`. 디바운스 타이머 취소.

턴 안의 `close_flow('agent')`는 같은 `TurnTx`에서 `answered_upto_id`를 먼저 갱신하므로, 4단계는 그 턴이 보지 못한 메시지만 옮긴다.

### 9.3 이벤트 핸들러

**handle_debounce**
- 흐름 없음: 대기 인바운드가 있고 인바운드 개시 예약(`slot='inbound'`, `scheduled`·`fired`)이 없으면 인바운드 예약 생성.
- 흐름 있음: 미응답이 있으면 `run_turn(debounce)`.

**handle_reservation(id)**
- 행 없음 → 폐기.
- 흐름 없음(개시 예약): 블랙아웃이면 끝으로 재예약. 아니면 `gate()` → `precheck` → `open_flow` → `run_turn(self)`.
- 흐름 있음 & self: 블랙아웃이면 아래 규칙. 아니면 `run_turn(self)`.
- 흐름 있음 & 개시 예약: `fired` 유지.

**블랙아웃 규칙(self 예약)** — 블랙아웃 중 self가 발화하면:
- 미응답이 있으면 `run_turn(self)`. 사용자에게 답하는 것이다.
- 없으면 턴 없이 `close_flow('blackout')`. 정리·공통 마무리.

즉 블랙아웃 중 self 예약은 "그때까지 답이 없으면 흐름을 접는다"는 뜻이다.

**handle_system**
1. 플랜이 밀리지 않았거나 `plan_retry_at > now`면 무시.
2. 흐름이 있고 현재 계획일 블랙아웃이 아직 안 끝났으면 무시(흐름이 닫히면 `finish()`가, 아니면 블랙아웃 끝에 `system_timer`가 다시 부른다).
3. `gate()` → 만료 검사(§10, §11. 활성 흐름의 `origin_pool_id` 제외) → 플랜(§12).

**handle_cleanup** — `cleanup_status='pending' AND cleanup_next_at <= now`인 흐름을 이른 순으로 하나 정리. 흐름이 열려 있어도 실행한다(닫힌 다른 흐름의 기억 쓰기라 사용자 접점이 없다).

### 9.4 턴

**`run_turn(trigger)`**
1. `gate()`.
2. 컨텍스트 조립(§6.1). 포함한 user 메시지의 최대 id를 `upto_id`로 기록.
3. LLM 호출·도구 라운드·파싱(실패 시 1회 재시도).
4. `TurnTx` commit — 한 트랜잭션:
   - self 예약 행 삭제(트리거 예약 또는 대기 중이던 self).
   - 도구 쓰기 효과.
   - assistant 메시지 저장(`sent_at=NULL`).
   - `turn_count++`, `prompt` 갱신, `answered_upto_id=upto_id`, `failure_count=0`.
   - 첫 턴이고 `consume_random`이면 `random_due--`.
   - reserve 반영(§5.1). `continue`면 self 예약 + pending 갱신. `end`면 개시 예약(단일성 교체).
   - `flow=end`면 `close_flow('agent')`.
5. 미응답이 남았으면(호출 중 도착) 디바운스 타이머 유지, 없으면 취소.
6. 전송: outbox를 `id` 순으로. 4096자 초과는 줄바꿈 경계 분할, 메시지 사이 `send_interval`, 429는 `retry_after` 대기. 403이면 남은 메시지 `undelivered`, 보류 `blocked` 진입, 이 턴의 나머지 단계 생략. 그 외 오류는 몇 회 재시도 후 그 메시지만 `undelivered`.
7. 흐름이 닫혔고 `cleanup_status='pending'`이면 `gate()` → 정리 1회 시도.
8. 흐름이 열려 있으면 압축 검사(§13.2, `gate()` 포함).
9. **턴 실패**(3단계 재시도 실패 또는 예외): `TurnTx`를 버리고 별도 한 트랜잭션에서 `failure_count++` + self 예약 행 삭제 + 백오프 self 삽입(`at=now+backoff(failure_count)`, 실패한 턴의 프롬프트) + pending 갱신. 흐름 유지. 미응답은 그대로라 백오프 턴이 다시 답한다.

### 9.5 공통 마무리와 재개

**`finish()`** — 흐름이 닫힌 뒤, 그리고 `resume()` 끝에서.

```
finish():
  if hold_reason: return
  while current_flow_id IS NULL:
    r = 개시 예약 WHERE state='fired' ORDER BY at, id LIMIT 1
    if r is None: break
    if 블랙아웃: r.state='scheduled', r.at=블랙아웃 끝; continue
    if not gate(): return
    if not precheck(r): continue                  # precheck가 r을 지운다
    open_flow(r); run_turn(self)                   # 첫 턴에 닫히면 루프 계속
  if current_flow_id IS NULL: handle_system()
  if current_flow_id IS NULL and 대기 인바운드 有 and 인바운드 개시 예약 無:
    인바운드 예약 생성
  재조준(flow_timer, system_timer, cleanup_timer)
```

`run_turn` 안에서 `finish()`를 부르지 않는다. 재귀가 아니라 루프다.

**`resume()`** — 시작(§15.1)과 보류 해제(§9.6)가 공유하는 절차.
1. 모든 타이머 재조준.
2. outbox: 낡지 않은 것은 `id` 순으로 전송, 낡은 것은 `undelivered`. 전송 중 403이면 남은 것 `undelivered`, 보류 `blocked` 진입 후 `resume()` 중단.
3. 열린 흐름이 있으면:
   - self 예약이 낡았으면(`at < now - stale_after_sec`) `close_flow('stale')`. 미응답은 인바운드로 옮겨진다.
   - 아니고 self가 `fired`면 `reservation_due(self)`를 큐에 넣는다(블랙아웃 규칙 적용).
   - self가 없으면 복구 self(`at=now+min_lead`, `flows.prompt`). `failure_count`는 그대로.
   - 흐름이 남아 있고 미응답이 있으면 `debounce_expiry`를 즉시 큐에 넣는다.
4. `finish()`(흐름이 없을 때 deferred·플랜·인바운드 처리).

### 9.6 보류

| 사유 | 진입 | `hold_until` | 해제 |
|---|---|---|---|
| `balance` | 게이트에서 잔액 부족 | `now + balance_retry_sec` | `hold_check`에서 잔액 회복 |
| `daily_limit` | 게이트에서 일일 상한 | 다음 로컬 자정 | `hold_check`에서 날짜 변경(지연 리셋) |
| `blocked` | 전송 중 403 | NULL | 사용자의 다음 메시지(`debounce_expiry`) |

- 진입: `hold_reason`·`hold_until` 기록, `hold_timer` 무장, 운영자 알림(로그. `blocked`가 아니면 텔레그램도).
- `hold_check`가 해제 조건을 못 만족하면 `hold_until`을 다시 정하고 기다린다.
- **해제**: `hold_reason=NULL`, `hold_until=NULL` → `resume()`.
- 보류 중 수신은 평소대로 기록된다(흐름이 있으면 `messages`, 없으면 인바운드).

---

## 10. 인바운드

- **수신(흐름 없음)**: `inbound_messages`에 `pending` 저장, 디바운스 타이머 재설정. 블랙아웃 무관.
- **수신(흐름 있음)**: `messages`에 저장(미응답이 된다), 디바운스 타이머 재설정. 블랙아웃 무관.
- **인바운드 개시 예약**: `slot='inbound' AND state IN ('scheduled','fired')` 중 self가 아닌 것. 흐름이 없을 때만 검사하므로 self와 섞이지 않는다.
- **개시**: 디바운스 만료 또는 `finish()`가 예약 생성(`at=now`, 블랙아웃이면 끝, prompt=`inbound_prompt`). 발화 시 `open_flow`가 그 시점의 `pending` 전부를 복사·소비한다.
- **만료**(만료 검사 시): `received_at`이 `inbound_ttl_sec`를 넘었거나 `pending`이 `inbound_max_pending`을 넘으면 오래된 것부터 `expired`. 수신 핸들러는 상태를 바꾸지 않으므로 상한 정리는 만료 검사에서만 한다.
- 텍스트가 `/`로 시작해도 일반 메시지다. 명령어는 없다.

---

## 11. 비동기 풀

- **생성**: `pool_create` → `pending` + deadline 개시 예약(`payload.pool_id`).
- **마감**: 개시 예약 발화 → `open_flow`가 `due`로 바꾸고 마감 흐름을 연다. 이벤트 블록에 `pool_focus`.
- **판정**: `judged` → 사유 기록, deadline 개시 예약 삭제. `due_keep` → 유지. 재검사는 `end` reserve가 만든다(§5.1). 같은 턴에서 `judged` 후 `end` reserve를 내면 그 예약은 `main`이 된다.
- **재발행**: `replaces` → 원본 `reissued`(예약 삭제), 신규 `pending`.
- **만료**(만료 검사 시): `created_at`이 `pool_ttl_sec`를 넘었거나 `pending+due`가 `pool_max_pending`을 넘으면 오래된 것부터 `expired`, 예약 삭제. 활성 흐름의 `origin_pool_id`는 제외.
- `pool_judge`는 턴 도구이므로 어느 흐름에서든 가능하다.

---

## 12. 데일리 플랜

- **발화**: `system_due`(§9.3 handle_system) 또는 `finish()`. 블랙아웃 진입 시각이 기본이고, 흐름이 블랙아웃을 넘기면 그 블랙아웃 끝에 턴 사이에서, 흐름이 그보다 먼저 닫히면 그때 돈다.
- **입력**: `plan-rules.md`, `state.md`, 이벤트 블록(계획일, 전 계획일 미완 항목).
- **성공**: 계획일 행으로 전체 교체(`plan_max_items` 초과분은 앞에서부터 자름), `reserve`가 있으면 `main` 개시 예약(단일성 교체), `last_plan_date=계획일`, `plan_attempts=0`, `plan_retry_at=NULL`.
- **실패**(파싱 1회 재시도 후, 또는 예외): `plan_attempts++`, `plan_retry_at=now+backoff(plan_attempts)`. 만료 검사는 이미 반영된 채로 둔다. `system_timer`가 재시도 시각을 조준한다.
- **비활성**(`plan-rules.md` 없음): 만료 검사만 하고 `last_plan_date=계획일`.
- **턴 중 조작**: `plan_done`, `plan_add`는 `TurnTx`로.

---

## 13. 정리와 압축

### 13.1 정리

- **발화**: 흐름이 닫힌 직후 1회 동기 시도(`run_turn` 7단계, 블랙아웃 규칙, `resume()`의 stale 닫기 뒤). 이후는 `cleanup_timer`만.
- **입력**: §6.3. **도구**: `memory_read/write/create`(`MemoryTx`). `state.md` 갱신도 같은 commit.
- **성공**: `done`, `cleanup_next_at=NULL`.
- **실패**: `cleanup_attempts++`, `cleanup_next_at=now+backoff(cleanup_attempts)`.
- 보류 중에는 돌지 않고, 해제 후 `resume()`의 재조준으로 이어진다.

### 13.2 압축

- **발화**: `run_turn` 8단계. 비압축 구간(`ignored=0`, `id > compacted_until_id`)의 문자 수 합이 `flow_compact_chars` 초과 시.
- **범위**: 가장 오래된 메시지부터 남은 구간이 `flow_compact_chars / 2` 이하가 될 때까지, 최소 1개.
- **출력·반영**: `summary` 갱신, `compacted_until_id`를 대상의 마지막 id로. 실패 시 로그만, 다음 턴 재시도.

---

## 14. 메모리 파일

하네스는 기억 파일의 내용을 해석하지 않는다.

| 파일 | 로드 | INDEX |
|---|---|---|
| `memory/state.md` | 매 턴·플랜·정리에 통째로 | 제외 |
| `memory/*.md` | INDEX만, 본문은 `memory_read` | 포함 |

- 쓰기는 정리 호출만. `memory_write`는 전체 교체.
- 섹션 구조와 의미는 `cleanup-rules.md`(운영자 소유)가 정한다.

---

## 15. 시작·복구·리셋

### 15.1 시작(첫 실행과 재시작 공통)

1. `config` 로드·zod 검증. 블랙아웃 빈 값, `call-rules.md`·`inbound_prompt` 파일 부재면 시작 실패.
2. `aigan.lock` 획득(단일 인스턴스). 실패면 시작 실패.
3. DB 마이그레이션. `harness_state` 행이 없으면 §3 초기값.
4. 보류 중이면 타이머를 무장하고 `hold_timer`에 맡긴다. 아니면 `resume()`(§9.5).

첫 실행은 `last_plan_date=NULL`이라 `resume()` → `finish()` → `handle_system()`에서 바로 플랜이 돈다. 재시작은 진행 중이던 LLM 호출을 잃는데, 그 턴은 커밋되지 않았으므로 self 예약·미응답이 그대로라 `resume()` 3단계가 다시 돌린다.

### 15.2 일시정지

명령어는 없다. 프로세스(컨테이너)를 멈추고 다시 띄운다. 재시작 시 낡음 규칙(§9.5)이 오래된 outbox와 낡은 self를 정리한다. 개시 예약은 `main`·`inbound`가 각 1개, `deadline`이 항목당 1개라 재시작 때 쏟아지는 양이 제한된다.

### 15.3 리셋 CLI

프로세스가 멈춘 상태에서만 동작한다(`aigan.lock` 획득 실패 시 거부).

**`aigan reset`** — 런타임 상태만 비운다. 대화 기록(`messages`, `flows`, `llm_calls`)과 `memory/`는 유지.
- 열린 흐름 → `close_flow('reset')`(정리 `skipped`, 미응답 `ignored_reason='reset'`).
- `reservations` 전부 삭제. 인바운드 `pending` → `expired`. 풀 `pending`/`due` → `judged`(`cancelled`). `plan_items` 삭제.
- outbox → `undelivered`. `cleanup_status='pending'` → `skipped`.
- `harness_state`: 보류·`random_due`·`failure_count`·`plan_attempts`·`plan_retry_at`·`last_plan_date` 초기화. **`daily_calls`는 유지**(리셋으로 비용 상한을 우회하지 않는다).
- 다음 시작에서 플랜이 바로 돌아 새 예약을 만든다.

**`aigan reset --all`** — `aigan.db`와 `memory/`를 삭제한다(`config`·`prompts/`는 유지). 첫 실행 상태가 된다. 확인 입력을 요구한다.

---

## 16. 텔레그램 운영

- **chat_id 제한**: `owner_chat_id` 외 메시지는 로그 없이 버린다.
- **평문 전송**: `parse_mode` 미사용.
- **전송 규칙**: §9.4 6단계.
- **명령어 없음**: `/`로 시작하는 텍스트도 일반 메시지(§10).
- **차단**: 403 → 보류 `blocked`. 사용자가 차단을 풀고 메시지를 보내면 해제된다.

---

## 17. 확장 지점

- **새 job**: `prompts/jobs/`에 파일을 쓰고 reserve나 `pool_create`에서 지정. 코드 변경 없음.
- **새 도구**: `tools.ts`에 스키마·실행기, 호출 종류별 목록에 추가, 적용 규칙(즉시 읽기 vs `TurnTx`) 결정.
- **새 슬롯**: 허용값 추가, 그 슬롯의 개시 예약 생성 경로와 단일성 규칙(§5.1) 정의.
- **새 시스템 작업**: 프롬프트 파일 + 실행기 + 발화 조건. 상태는 DB에 두고 타이머가 조준하게 한다(원칙 5).
- **FE 교체**: 텔레그램 어댑터만 교체. 차단에 해당하는 오류를 보류 `blocked`로 매핑.
- **부트스트랩 세트**: `call-rules.md`, `jobs/generic.md`, `jobs/inbound.md`, `plan-rules.md`("오늘 물어볼 것 세 가지, 첫 접촉 reserve 필수"), `cleanup-rules.md`, 빈 `memory/state.md`. 이것으로 "매일 세 번 안부를 묻는 비서"가 돈다.

---

## 부록 A — 설정

단일 파일(`DATA_DIR/config`), 시작 시 로드(zod). 변경은 재시작.

| 키 | 기본 | 의미 |
|---|---|---|
| `timezone` | `Asia/Seoul` | IANA |
| `blackout` | `00:00-08:00` | 자정 넘김 허용, 빈 값 금지 |
| `inbound_prompt` | `prompts/jobs/inbound.md` | 인바운드 예약의 prompt. 시작 시 존재 검증 |
| `message_debounce_sec` | 20 | |
| `send_interval_ms` | 800 | 다중 메시지 간격 |
| `reservation_lead_min_sec` | 60 | |
| `reservation_lead_max_sec` | 10800 | |
| `stale_after_sec` | 1800 | outbox·self 예약의 낡음 기준 |
| `inbound_max_pending` | 10 | |
| `inbound_ttl_sec` | 86400 | |
| `pool_max_pending` | 10 | `pending+due` 상한 |
| `pool_ttl_sec` | 172800 | |
| `plan_max_items` | 3 | |
| `random_unit_sec` / `random_prob` / `random_max_due` | 3600 / 0.15 / 3 | |
| `failure_backoff_first_sec` | 600 | 턴·정리·플랜 공통 |
| `failure_backoff_cap_sec` | 7200 | |
| `failure_alert_after` | 3 | |
| `max_tool_rounds` / `max_cleanup_tool_rounds` | 3 / 5 | |
| `provider` | — | `openai` / `deepseek` |
| `model`, `api_key` | — | |
| `bot_token`, `owner_chat_id` | — | |
| `daily_call_limit` | — | |
| `balance_threshold`, `balance_retry_sec` | — | `deepseek`일 때만 |
| `flow_compact_chars` | 24000 | |
| `memory_file_max_chars` / `memory_max_files` | 8000 / 8 | |

---

## 부록 B — 설계 근거

| 결정 | 근거 |
|---|---|
| 운영 명령 제거 | 명령과 진행 중인 턴의 경합(세대 카운터, abort, 전송 중 비교, 명령 위임, 큐 맨 앞 삽입)이 2.x 복잡도의 최대 원천이었다. 운영자=사용자인 개인 서버에서는 프로세스 정지·대화·오프라인 CLI로 대체된다 |
| 리셋은 오프라인 CLI | 런타임 명령이면 진행 중인 턴과 다시 경합한다. 프로세스 밖이면 재시작 경로만 타면 된다 |
| 리셋이 `daily_calls`를 유지 | 리셋이 비용 상한 우회 수단이 되지 않게 한다 |
| 큐는 휘발성, 진실은 DB | 재시작·보류 해제가 같은 `resume()`으로 끝난다. 큐 이벤트 유실을 걱정할 곳이 없다 |
| 보류를 워커 게이트로 | 핸들러 중간에 막히면 반쯤 바뀐 상태(예: 예약은 지웠는데 턴은 못 돎)가 남는다. 상태를 바꾸기 전에 막고 흔적만 남긴다 |
| 403을 보류 `blocked`로 | 차단도 "LLM을 불러도 보낼 수 없는" 상태다. 사용자의 다음 메시지가 해제 신호가 된다 |
| `answered_upto_id` | "답했는가"를 assistant 행 존재로 추론하면 메시지 없는 턴에서 틀린다. 버퍼·복구·블랙아웃 규칙·`close_flow`가 같은 값을 본다 |
| `main` 개시 예약 단일 | 흐름은 예약을 1:1로 교체하는데 플랜이 매일 하나를 더해 누적된다. LLM은 그걸 볼 수 없다. 단일성은 코드로, 현재 값은 `next_main`으로 보여준다 |
| 계획일 = 블랙아웃 끝 날짜 | 진입 시각 날짜를 쓰면 자정을 넘는 블랙아웃에서 중복·누락이 난다 |
| `pending_system_event` 제거 | "플랜이 밀렸는가"는 `last_plan_date`와 현재 계획일에서 파생된다. 플래그를 따로 두면 동기화 지점이 늘어난다 |
| 플랜 실패 재시도 | 실패한 플랜은 첫 예약도 못 만들어 최대 24시간 공백이 생긴다 |
| deferred의 블랙아웃 재예약 | 흐름이 블랙아웃 중 닫히면 `finish()`가 대기 예약을 열어 먼저 말을 건다 |
| self 예약은 블랙아웃 보정 안 함 | 보정하면 흐름이 밤새 열려 플랜이 밀린다. 블랙아웃 중 발화는 "답 없으면 접기" |
| self 예약에 payload 없음 | `pool_id` 기준 삭제가 흐름 자신의 self를 지워 (d)를 깨지 않게 한다 |
| `end` reserve 기본 `main` | 슬롯은 "누가 열었나"다. 인바운드·마감 흐름의 후속이 그 슬롯을 차지하지 않는다 |
| `close_flow` 단일 연산 | 닫는 경로마다 정리하면 빠진다(2.x의 유령 흐름) |
| 미응답은 인바운드로 이동 | 흐름이 닫히며 사용자의 말을 버리지 않는다 |
| 인바운드 복사는 `open_flow` 한 곳 | 수신분과 이동분이 같은 경로를 탄다 |
| 정리 재시도를 DB + 타이머로 | 큐 이벤트는 휘발성이다. 흐름 중에도 실행(다른 흐름의 기억 쓰기라 무해) |
| 사전 검사 | 열 수 없는 예약(프롬프트 없음, 인바운드 0건, 판정된 풀)으로 빈 흐름을 열지 않는다 |
| 낡음 기준 | 오래 멈췄다 돌아오면 지난 대화의 재전송·재개가 어색하다. 개시 예약은 단일성으로 양이 제한되므로 그대로 발화한다 |
| `TurnTx`에 reserve·닫기 포함, 전송은 커밋 뒤 | 전송과 상태 사이 크래시 구멍을 없앤다. 커밋 후 전송 전 크래시는 outbox 재전송으로 메운다 |
| 턴 실패 처리 한 트랜잭션 | 중간 크래시로 (d)가 깨지지 않는다 |
| `continue`의 무효 prompt는 `flows.prompt`로 | 재시도보다 싸고 (d)를 지킨다 |
| `turn_count` 0→1에서 `random_due` 감소 | 흐름당 정확히 한 번, 같은 트랜잭션 |
| 지연 리셋·지연 시행 | 자정·단위 타이머는 재시작에 놓친다 |
| 파싱 실패 1회 재시도 | 일시적 오류로 턴이 유실되는 걸 막는다 |
| 강제 JSON 시 `tools` 유지 | 도구를 빼면 캐시가 깨진다 |
| 도구 쓰기 일괄 commit | 부분 적용은 재시도 시 상태를 꼬이게 한다 |
| 압축은 문자 수 기준, id 경계 | 토큰 로그는 전체 컨텍스트 기준이고, `ts`는 동시각 충돌이 난다 |
| 정리 입력은 요약 + 남은 구간 | 원본 전체는 압축의 비용 절감을 없앤다 |
| 플랜·압축에 도구 없음 | 단발 호출이다. 플랜은 INDEX 대신 `state.md` |
| `pool` 요약 5개 상한 | 이벤트 블록 낭비를 막는다 |
| 경로 검증 | `DATA_DIR` 밖 파일 접근을 막는다 |
| `provider`별 잔액 확인 | OpenAI에는 잔액 API가 없다 |

---

## 부록 C — 테스트 케이스

### 시작·리셋

| # | 상황 | 기대 |
|---|---|---|
| 1 | 첫 실행 | 초기값, 즉시 플랜, 플랜 reserve로 `main` 개시 예약 |
| 2 | 첫 플랜 reserve null | 다음 블랙아웃까지 먼저 말 걸지 않음 |
| 3 | 블랙아웃 빈 값 / `inbound_prompt` 없음 | 시작 실패 |
| 4 | 두 번째 인스턴스 시작 / 실행 중 `aigan reset` | 잠금 거부 |
| 5 | `aigan reset` | 런타임 비움, 기록·`memory/`·`daily_calls` 유지, 다음 시작 시 플랜 |
| 6 | `aigan reset --all` | 첫 실행 상태 |

### 수신·인바운드

| # | 상황 | 기대 |
|---|---|---|
| 7 | 흐름 없음 + 메시지 → 디바운스 | 인바운드 예약 → `open_flow`가 복사 → 첫 턴 컨텍스트에 포함 |
| 8 | 블랙아웃 중 흐름 없음 + 메시지 | `pending`, 인바운드 예약은 블랙아웃 끝 |
| 9 | `fired` 인바운드 개시 예약 대기 중 디바운스(흐름 없음) | 새 예약 안 만듦 |
| 10 | `close_flow` 커밋 후 `finish()` 전 수신 | `finish()`가 인바운드 예약 1개 |
| 11 | 인바운드 예약 발화 시 `pending` 0건 | 사전 검사로 예약만 삭제 |
| 12 | 인바운드 시간·상한 초과 | 오래된 것 `expired` |
| 13 | "/pause" 텍스트 | 일반 메시지 |

### 턴

| # | 상황 | 기대 |
|---|---|---|
| 14 | self 발화 | 턴 |
| 15 | self 전에 사용자 응답 | 디바운스 턴, 옛 self 삭제, 새 self |
| 16 | 디바운스 대기 중 self 발화 | self 턴이 답함, `answered_upto_id` 갱신, 이어진 디바운스는 미응답 없음으로 무시 |
| 17 | 턴 LLM 호출 중 새 메시지 | 미응답으로 남아 디바운스 턴 |
| 18 | `messages=[]` continue 후 재시작 | 재응답 없음 |
| 19 | `messages=[]` continue 후 블랙아웃 self 발화 | `close_flow('blackout')` |
| 20 | `flow=end` + reserve | `main` 개시 예약(기존 교체) |
| 21 | `flow=end`, reserve 없음 | `system_timer`가 보루 |
| 22 | `end` 턴 호출 중 도착한 메시지 | `moved` → 인바운드 → 인바운드 흐름이 답함 |
| 23 | 위 상황이 블랙아웃 중 | 인바운드 예약이 블랙아웃 끝 |
| 24 | continue + prompt 무효 | `flows.prompt`로 self |
| 25 | end + prompt 무효 | 예약 폐기, 흐름 닫힘 |
| 26 | `reserve.prompt="../../etc"` | 경로 거부 |
| 27 | `reserve.at` 1주 뒤 / 30초 뒤 | `max_lead` / `min_lead` |
| 28 | `consume_random=true` 첫 턴 / 실패 / 둘째 턴 | 1 감소 / 미감소 / 무시 |
| 29 | 목록 밖 도구 | 거부, 턴 계속 |
| 30 | `memory_read("../../x")` | 거부 |
| 31 | 사용자 "그만" | (콘텐츠 계약) LLM이 `flow=end` |

### 실패

| # | 상황 | 기대 |
|---|---|---|
| 32 | 파싱 실패 1회 | 재시도 |
| 33 | 재시도 실패 | 한 트랜잭션으로 `failure_count++`·백오프 self |
| 34 | 3회 연속 | 백오프 증가, 알림 1회 |
| 35 | 네트워크 오류 | 같은 실패 경로 |
| 36 | 실패 처리 트랜잭션 중 크래시 | 롤백, 기존 self 유지 |
| 37 | 블랙아웃 중 백오프 self, 미응답 있음 | 턴 |
| 38 | 블랙아웃 중 self, 미응답 없음 | 흐름 닫힘, 정리, 플랜 |

### deferred·블랙아웃

| # | 상황 | 기대 |
|---|---|---|
| 39 | 흐름 중 개시 예약 발화 | `fired`, 흐름 종료 후 `at` 순 |
| 40 | deadline + main 흐름 활성 | 마감 흐름은 main 종료 후 |
| 41 | deferred 3개, 각 첫 턴 `end` | `finish()` 루프로 차례로 |
| 42 | 흐름 중 deferred, 블랙아웃 중 흐름 종료 | 블랙아웃 끝으로 재예약 |
| 43 | 흐름 없음, 개시 예약이 블랙아웃 중 발화 | 끝으로 재예약 |
| 44 | 블랙아웃 진입 + 활성 흐름 | `system_due` 무시, 흐름 이어짐, 닫히면 플랜 |
| 45 | 흐름이 블랙아웃 끝까지 이어짐 | 끝 시각에 턴 사이 플랜, `origin_pool_id` 만료 제외 |
| 46 | 블랙아웃 중 활성 흐름에 응답 | 정상 턴 |

### main 단일성

| # | 상황 | 기대 |
|---|---|---|
| 47 | 플랜 reserve + 기존 `scheduled` main | 교체 |
| 48 | `end` reserve + `fired` main | 교체 |
| 49 | 플랜 reserve null + 기존 main | 유지 |
| 50 | 이벤트 블록 | `next_main` 표시 |

### 플랜

| # | 상황 | 기대 |
|---|---|---|
| 51 | `00:00-08:00` | 계획일당 1회 |
| 52 | `23:00-07:00`, D+1 01:00 재시작 | 재실행 없음 |
| 53 | `23:00-07:00`, D+1 23:00 진입 | 실행(계획일 D+2) |
| 54 | 플랜 실패 | `plan_retry_at` 백오프, 재시도, 알림 |
| 55 | `plan-rules.md` 없음 | 만료 검사만, `last_plan_date` 갱신 |
| 56 | items 상한 초과 | 앞에서부터 자름 |
| 57 | 이벤트 블록 plan | 현재 계획일 항목만 |

### 풀

| # | 상황 | 기대 |
|---|---|---|
| 58 | `pool_create` → 마감 | `due`, `pool_items.prompt`, `pool_focus` |
| 59 | `judged` | 개시 예약 삭제 |
| 60 | `due_keep` + `end` reserve | deadline 개시 예약(`pool_id` 상속) |
| 61 | `judged` 후 `end` reserve | `main` |
| 62 | `replaces` | 원본 `reissued`, 예약 삭제, 신규 `pending` |
| 63 | 상한에서 `pool_create` | 거부 |
| 64 | 만료 | `expired`, 예약 삭제 |
| 65 | 마감 흐름 중 그 항목 만료 시도 | 제외 |
| 66 | 이미 `due`인 항목 재마감 | `due_at` 유지 |
| 67 | 20건 | 5개 + `… 외 15건` |
| 68 | deadline 예약의 prompt 파일 삭제됨 | 사전 검사로 삭제, 풀 상태 불변 |

### 정리·압축

| # | 상황 | 기대 |
|---|---|---|
| 69 | 정리 성공 | `done` |
| 70 | 정리 실패 | `cleanup_next_at` 백오프, 타이머 재시도 |
| 71 | 흐름 열린 상태에서 `cleanup_due` | 실행 |
| 72 | `cleanup-rules.md` 없음 | `skipped`, 소급 없음 |
| 73 | 정리 입력 | 요약 + 남은 구간, `ignored=1` 제외 |
| 74 | 압축 임계 초과 | `summary`·`compacted_until_id` 갱신 |
| 75 | 압축 실패 | 로그, 다음 턴 재시도 |
| 76 | 플랜·압축 호출 | `tools` 미제공 |

### 전송

| # | 상황 | 기대 |
|---|---|---|
| 77 | 5000자 | 분할 |
| 78 | 커밋 후 전송 전 크래시, 곧 재시작 | outbox 재전송 |
| 79 | 오래 다운 후 재시작 | 낡은 outbox `undelivered` |
| 80 | 403 | 남은 것 `undelivered`, 보류 `blocked`, 이 턴의 정리·압축 생략 |
| 81 | `blocked` 중 사용자 메시지 | 해제 → `resume()` |
| 82 | 그 외 전송 오류 | 그 메시지만 `undelivered` |

### 보류

| # | 상황 | 기대 |
|---|---|---|
| 83 | 일일 상한 도달 상태에서 개시 예약 발화 | `open_flow` 안 함, `fired` 유지 |
| 84 | 보류 중 열린 흐름의 self 발화 | `fired` 유지, (d) 유지 |
| 85 | 보류 중 블랙아웃 진입 | 무시, 해제 후 플랜 |
| 86 | 자정 `hold_check` | 해제 → `resume()` → deferred·플랜·미응답 처리 |
| 87 | 잔액 부족 | `balance_retry_sec` 뒤 재확인 |
| 88 | 보류 중 정리·압축 | 돌지 않음, 해제 후 이어짐 |

### 복구

| # | 상황 | 기대 |
|---|---|---|
| 89 | 디바운스 대기 중 재시작 | 미응답으로 즉시 디바운스 턴 |
| 90 | self 턴 중 크래시 | `fired` self 재큐 |
| 91 | 열린 흐름에 self 없음 | 복구 self, `failure_count` 불변 |
| 92 | 열린 흐름의 self가 낡음 | `close_flow('stale')`, 미응답 인바운드로 |
| 93 | `fired` 개시 예약만 있음 | `finish()`에서 처리 |
| 94 | 블랙아웃 중 재시작 + `fired` main | 블랙아웃 끝으로 재예약 |
| 95 | 정리 pending 상태로 재시작 | 타이머로 재시도 |
| 96 | 자정 넘겨 재시작 | 첫 요청 직전 `daily_calls` 리셋 |

### 통합

| # | 상황 | 기대 |
|---|---|---|
| 97 | 부트스트랩 세트만으로 실행 | 매일 세 번 안부 |
| 98 | 디바운스 턴 이벤트 블록 | `memo`=대기 self의 memo, `prompt`=`flows.prompt` |
