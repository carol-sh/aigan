# aigan-harness 설계 추적 (v2.5 기준)

> 목적: 설계 문서(`harness-design.md` v2.5)를 상태 × 이벤트 매트릭스와 시나리오 추적으로 훑어 모순·누락을 찾고, 부록 C의 테스트 커버리지 구멍을 메운다.
> 표기: `#N`은 부록 C 테스트 번호, `F-N`은 이 문서의 발견 항목, `T-N`은 새 테스트 후보.

---

## 1. 상태 공간

추적에 쓰는 상태 축은 다섯이다.

| 축 | 값 |
|---|---|
| 모드 | `paused` / `active` |
| 보류 | `pause_reason` NULL / `balance` / `daily_limit` (active일 때만 의미) |
| 흐름 | 없음 / 열림-유휴(턴 사이) / 열림-턴 실행 중 / 열림-전송 중 |
| 시간 | 블랙아웃 밖 / 블랙아웃 안 |
| 대기 상태 | `fired` 예약 유무, `pending_system_event`, 버퍼 유무, `cleanup_status='pending'` 유무 |

워커는 직렬이므로 "턴 실행 중"·"전송 중"에 끼어들 수 있는 것은 **수신 핸들러**와 **command_handler의 즉시 부분**, 그리고 **타이머 발화(큐 투입만)** 뿐이다.

---

## 2. 이벤트 × 상태 커버리지 매트릭스

칸: 커버하는 테스트 번호. `—`는 테스트 없음, `F-N`은 추적 중 결함 발견.

### 2.1 수신(사용자 메시지)

| 상태 | 블랙아웃 밖 | 블랙아웃 안 |
|---|---|---|
| paused | #1 | — (T-1) |
| active·보류 중·흐름 없음 | — (F-2) | — |
| 흐름 없음 | #4 | #3 |
| 흐름 열림-유휴 | #7 | #48 |
| 흐름 열림-턴 실행 중 | #56, #80 | #78 |
| 흐름 열림-전송 중 | — (T-2) | — |
| `close_flow` 커밋 ~ `finish()` 사이 | — (T-3) | — |

### 2.2 큐 이벤트

| 이벤트 | paused | 보류 중 | 흐름 없음 | 흐름 열림 |
|---|---|---|---|---|
| `debounce_expiry` | — | — (F-2) | #4, #75 | #7, #55 |
| `reservation_due` self | — | — (F-2) | 해당 없음 | #5, #49, #50 |
| `reservation_due` 그 외 | #31 간접 | — (F-2) | #13 | #6, #8 |
| `system_event` | — | — (F-2) | #2 | #23, #34 |
| `system_catchup` | — | — | — | #62 |
| `cleanup_due` | #70, #72 | — | #10 | #84 (#71과 모순, F-10) |
| `command /pause` | #76 | — | — (T-4) | #30, #68 / 턴 중 — (T-5) |
| `command /resume` | #2, #31, #61, #74 | — (F-2) | 해당 없음 | 해당 없음 |
| `command /cancel` | #76 | — | — (T-6) | #22, #67, #60, #85 |

### 2.3 연산 단위

| 연산 | 분기 | 커버 |
|---|---|---|
| `run_turn` 종료 | 성공 continue | #5 |
| | 성공 end | #9, #26 |
| | 성공, `messages=[]` | — (**F-4**) |
| | 파싱 실패 → 백오프 | #21, #45 |
| | 세대 불일치(abort) | #73 |
| | 일반 예외(네트워크·5xx) | — (T-7) |
| | 보류(`balance_guard`) | #32 (**F-2**) |
| `close_flow` | agent / blackout / paused / cancelled | #77·#80 / #49·#69 / #30·#68 / #22·#79 |
| `open_flow` | main / inbound / deadline | #5 / #81·#82 / #13 |
| | prompt 파일 없음 | — (F-11) |
| | inbound인데 `pending` 0건 | — (F-11) |
| | `finish()`가 블랙아웃 중 deferred 개시 | — (**F-3**) |
| 전송 | 성공 / 403 / 그 외 오류 / 세대 변경 | #24 / #36·#52 / — / #85 |
| | 4096자 분할된 메시지의 `/cancel` 삭제 | — (F-12) |
| 플랜 | 성공 | #2 |
| | 실패(파싱 재시도 후) | — (**F-7**) |
| | `plan-rules.md` 없음 | — (F-13) |
| | 자정을 넘는 블랙아웃 | — (**F-6**) |
| 정리 | 성공 / 실패 / skip | #10 / #10, #70 / #22 |
| 압축 | 성공 / 실패 | #29 / — (T-8) |
| 풀 | create / judge / due_keep / reissue / expire | #13 / #14·#46 / #15 / #16 / #17·#64 |
| | `pool_max` 도달 상태에서 create | — (F-14) |
| 복구 단계 | 1 / 2 / 3 / 4 / 5 / 6 / 7 / 8 / 9 | #72 / #51 / #11 / #12·#57 / #58·#59 / — / — / — / #35 |

---

## 3. 시나리오 추적

각 시나리오는 문서 규칙만으로 한 단계씩 진행한다. 문서가 답을 주지 않거나 모순되는 지점에서 멈추고 F-N으로 기록한다.

### S1. 보류 중 첫 턴 (F-2)

1. deadline 예약 R(pool #3)이 발화 → `reservation_due(R)`.
2. 흐름 없음 → `open_flow(R)`: R 삭제, 흐름 F 생성, pool #3 `due`. 커밋.
3. `run_turn(self)` 1단계 `balance_guard`: `daily_calls >= limit` → `pause_reason='daily_limit'`, **이벤트 재큐**, 종료.
4. 재큐된 `reservation_due(R)` → R은 이미 삭제 → "행 없음, 폐기".
5. 결과: 흐름 F는 열려 있는데 `pending_self_reservation_id`가 없다. **불변식 (d) 위반.** 자정이 지나도 F를 진행시킬 경로가 없다(사용자가 말을 걸 때까지).

추가로:
- "이벤트 재큐"는 지연 없이 다시 큐에 넣는 것으로 읽힌다. 그러면 다음 이벤트도 같은 가드에 걸려 재큐 → **바쁜 재순환**(`pending_system_event`가 피하려던 패턴).
- `balance_guard`는 `run_turn`에만 있다. 플랜·정리·압축도 LLM 호출이고 `daily_calls`를 올리지만 가드를 거치지 않는다.
- `/resume`이 active 상태의 보류를 풀 수 있는지 불명확하다(§9.2 표의 "정지 아님" 칸은 `command_handler`만 다룬다).

### S2. 흐름 중 블랙아웃을 넘긴 deferred (F-3)

1. 23:50 main 흐름 F 진행 중. 23:55에 main 예약 M 발화 → F가 열려 있으므로 `fired`(deferred).
2. 00:00 블랙아웃 진입 → `pending_system_event=1`.
3. 사용자가 00:30까지 대화, LLM이 `flow=end` → `close_flow('agent')` → `finish()`.
4. `finish()` 루프: `fired` M을 꺼내 `open_flow(M)` → `run_turn(self)` → **00:30에 시스템이 먼저 말을 건다.**

§8 "발화 시점에 다시 확인"은 타이머 발화에만 적용되고, `finish()`의 deferred 처리에는 블랙아웃 검사가 없다. 재시작 복구 9단계의 `finish()`도 같다. 인바운드 개시 예약도 같은 경로를 탄다(흐름 없는 인바운드는 블랙아웃 끝까지 미룬다는 v2.1 결정과 충돌).

### S3. 메시지 없는 턴 (F-4)

1. 흐름 F, 사용자 메시지 u1(id=40) → 디바운스 턴. `upto_id=40`.
2. LLM이 `{"messages": [], "flow": "continue", "reserve": {...}}`를 낸다(§7.1이 0개를 허용).
3. 커밋. 버퍼에서 id≤40 제거. assistant 행은 생기지 않는다.
4. 이후 두 규칙이 "마지막 assistant 메시지 뒤 유효 user 메시지"로 미응답을 판정한다.
   - 재시작 복구 4단계: u1을 미응답으로 보고 버퍼에 복원 → **u1에 다시 답한다.**
   - 블랙아웃 규칙: self가 블랙아웃에 발화하면 u1을 대기 중으로 보고 → **블랙아웃에 턴을 돌린다**(흐름을 접어야 할 상황).

"답했는가"를 assistant 행 존재로 추론하는 게 근본 원인이다. 커밋된 `upto_id`를 흐름에 저장하면 버퍼·복구·블랙아웃 규칙·`close_flow`의 `upto_id` 인자가 모두 같은 값을 보게 된다.

### S4. main 예약 누적 (F-5)

1. 0일차 밤: 플랜이 `reserve` → main 예약 P1.
2. P1 흐름 → `end` + reserve → M1. 흐름 하나가 예약 하나를 소비하고 최대 하나를 만든다.
3. 1일차 밤: 플랜이 또 `reserve` → P2. 이제 예약은 M1(또는 그 후속)과 P2, **둘**이다.
4. 매일 플랜이 하나씩 더하고, 흐름은 1:1로 갈아끼우므로, `end`에서 reserve를 생략하지 않는 한 **예약 수가 하루에 하나씩 늘어난다.** 인바운드·deadline 흐름의 `end` reserve도 v2.2부터 `main`이므로 같이 늘린다.
5. 이벤트 블록에는 예약 목록이 없어서 LLM은 이미 예약이 있는지 알 수 없다.

### S5. 자정을 넘는 블랙아웃의 플랜 날짜 (F-6)

설정 `blackout=23:00-07:00`.
1. D일 23:00 진입 → 플랜, `last_plan_date=D`(그 시각의 로컬 날짜).
2. D+1일 01:00 재시작 → 복구 8단계 "`last_plan_date` 미완"을 "오늘(D+1)이 아님"으로 읽으면 → **플랜을 한 번 더 돌린다.** `/resume`도 같다.
3. D+1일 23:00 진입 → `last_plan_date`가 D+1(2단계에서 갱신됐다면)이면 "오늘이면 다음 날로 건너뛴다"에 걸려 **그날 플랜을 건너뛴다.**
4. `{today}`·`plan_items.plan_date`도 "어느 날의 계획인가"를 진입 시각 날짜로 잡으면 23:00에 짠 계획이 하루 어긋난다.

### S6. 플랜 실패 (F-7)

1. 00:00 `system_event` → 만료 검사 → `plan_runner`.
2. JSON 파싱 실패 → 1회 재시도도 실패.
3. 문서는 플랜 실패 처리를 정의하지 않는다. `last_plan_date`는 갱신되지 않고, 플랜이 낼 첫 `reserve`도 없다.
4. 다른 예약이 없다면 다음 깨어남은 **다음 날 블랙아웃 진입**(24시간 공백). 재시작이나 `/resume`이 있어야만 복구 8단계로 다시 시도된다.

### S7. 정지 → 재개 시 flow_timer (F-1)

1. `/pause` 워커: `close_flow` → `mode=paused`, **모든 타이머 정지**.
2. `/resume` 워커: `mode=active` … `finish()`가 `cleanup_timer`·`system_timer`를 재조준.
3. `flow_timer` 재조준은 어디에도 없다. 재개 후 `scheduled` 예약은 다른 쓰기가 일어나 재조준될 때까지 발화하지 않는다. #31("과거 예약 즉시 발화")은 문서 규칙으로 성립하지 않는다.

### S8. 403과 흐름 종료가 겹침 (F-9)

1. 턴이 `flow=end`로 커밋(`close_flow('agent')`, `cleanup_status=pending`).
2. 6단계 전송 중 403 → "`/pause`와 동일 처리".
3. 이 경로는 command 이벤트가 아니라 `run_turn` 내부다. 문서가 정하지 않은 것:
   - 7단계 정리 동기 시도와 공통 마무리(`finish()`)를 하는가? `finish()`가 deferred 흐름을 열면 차단된 사용자에게 또 전송한다.
   - `close_flow('paused')`를 다시 부르는가? 흐름은 이미 닫혔다.
   - 대기 중이던 `end` reserve는 남는다(정지 중이라 발화는 안 함).

### S9. `finish()` 안의 첫 턴이 보류·실패·취소로 끝남

| 첫 턴 결과 | 흐름 | (d) | `finish()` 루프 | 판정 |
|---|---|---|---|---|
| 성공 continue | 열림 | self 있음 | 종료 | 정상 |
| 성공 end | 닫힘 | — | 다음 deferred | 정상(#66) |
| 파싱 실패 | 열림 | 백오프 self | 종료 | 정상 |
| 세대 불일치 | 열림 | **없음** | 종료 | 큐 맨 앞의 command가 곧 닫으므로 무해. 명시 필요(T-9) |
| 보류 | 열림 | **없음** | 종료 | F-2 |

### S10. outbox 재전송 시점 (F-8)

1. 15:00 턴 커밋 직후 프로세스 다운. 서버가 이틀 뒤 03:00에 복구.
2. 복구 2단계가 이틀 전 메시지를 **블랙아웃 중에** 보낸다. 그 턴이 self 트리거였다면 시스템이 먼저 말을 건 메시지다.
3. 같은 문제가 긴 `/pause` 뒤 `/resume`에도 있다. 그동안 `at`이 지난 `scheduled` 예약이 재개 즉시 한꺼번에 발화한다(첫 하나는 흐름을 열고 나머지는 deferred).

### S11. 정상 경로 확인 (결함 없음)

다음은 추적 결과 문서만으로 일관되게 진행된다.
- 디바운스 턴 중 옛 self 발화 → 커밋이 행을 지우고 이벤트는 "행 없음" 폐기(#55 계열).
- deadline 흐름에서 `judged` 후 `end` reserve → `main`으로 생성, self 영향 없음(#46).
- 흐름 중 deadline deferred + 같은 항목을 다른 흐름이 judged → `fired` 행까지 삭제되어 유령 흐름 없음.
- `close_flow` 커밋 직후 ~ `finish()` 사이 수신 → 인바운드 `pending` → `finish()` 끝에서 인바운드 예약 생성, 이미 있으면 디바운스는 무시(T-3로 고정).
- `cleanup_next_at=now`로 닫은 직후 `cleanup_timer` 발화와 7단계 동기 시도가 겹침 → 큐의 `cleanup_due`가 나중에 "만료된 pending 없음"으로 무해하게 끝난다.

---

## 4. 발견 항목

| # | 심각도 | 요약 | 위치 | 제안 |
|---|---|---|---|---|
| F-1 | 버그 | `/resume`이 `flow_timer`를 재조준하지 않음 | §9.2, §9 `finish()` | `/resume`은 모든 타이머(flow·system·cleanup·디바운스) 재조준. 버퍼가 있으면 디바운스 즉시 만료 |
| F-2 | 버그 | 보류(`pause_reason`)가 (d)를 깨고, 재큐가 바쁜 재순환을 만들고, 플랜·정리·압축을 가드하지 않음 | §9.1, §9 `run_turn` 1단계 | **보류를 워커 수준 게이트로**: LLM이 필요한 이벤트는 처리하지 않고 DB에 남긴다(self·예약은 `fired`, 버퍼 유지, 플래그 유지). `hold_timer`가 `balance_retry_sec`/다음 자정을 조준, 해제 시 `/resume`과 같은 재개 절차. `/resume`은 보류도 해제 |
| F-3 | 버그 | `finish()`·복구가 블랙아웃 중 deferred 흐름을 연다 | §9 `finish()`, §15.2 | deferred 처리 시 블랙아웃이면 `state='scheduled'`, `at=블랙아웃 끝`으로 되돌린다(self가 아닌 모든 예약) |
| F-4 | 버그 | 메시지 없는 턴 뒤 복구·블랙아웃 규칙이 이미 답한 메시지를 미응답으로 판정 | §9 블랙아웃 규칙, §15.2 4단계 | `flows.answered_upto_id` 추가. 커밋 시 `upto_id`로 갱신. 버퍼 = `flow_id=현재 AND role=user AND ignored=0 AND id > answered_upto_id`. `close_flow`의 `upto_id` 인자는 이 값으로 대체 |
| F-5 | 설계 | main 예약이 하루 하나씩 누적, LLM은 모름 | §5.1, §6.2 | (a) `main` 슬롯을 단일 예약으로: 새 `main` 생성 시 기존 `scheduled` main 교체 (b) 이벤트 블록에 예약 목록 노출. 결정 필요 |
| F-6 | 버그 | 자정을 넘는 블랙아웃에서 플랜 중복·누락 | §3, §8, §12 | **계획일(plan key) = 블랙아웃 끝 시각의 로컬 날짜.** 현재 계획일 = 이미 시작된 가장 최근 블랙아웃의 계획일. "미완" = `last_plan_date < 현재 계획일`. `{today}`·`plan_date`도 계획일 |
| F-7 | 버그 | 플랜 실패 처리 없음 → 최대 24시간 공백 | §12 | `harness_state.plan_retry_at` 추가. 실패 시 `pending_system_event=1` 유지 + 백오프. `system_timer`가 이 시각도 조준. 재시도 상한 도달 시 운영자 알림 |
| F-8 | 설계 | 오래된 outbox·과거 예약이 재개·복구 즉시 쏟아짐, 블랙아웃 중 재전송 | §15.2 2·6단계, §9.2 `/resume` | outbox: `now - ts > max_lead`면 `undelivered`, 블랙아웃이면 끝까지 보류. 과거 예약: `at`이 `max_lead` 이상 지났으면 폐기(로그). 결정 필요 |
| F-9 | 명확화 | 403 경로가 `run_turn` 7·8단계와 `finish()`를 하는지 | §9.2 403, §16 | 403 → 그 자리에서 `/pause` 워커 처리(열린 흐름이면 `close_flow('paused')`, 정리 1회), 7·8단계와 `finish()`는 건너뜀 |
| F-10 | 문서 | #71이 v2.5 규칙(흐름 중에도 정리)과 모순 | 부록 C | #71 수정 |
| F-11 | 명확화 | `open_flow` 전 prompt 파일 없음 / inbound인데 pending 0건 | §9 `open_flow`, §6.2 | 개시 전 검사: prompt 없으면 예약 삭제·로그, 흐름 안 엶. inbound인데 pending 0건이면 예약만 삭제. `inbound_prompt` 존재는 시작 검증에 포함 |
| F-12 | 명확화 | 4096자 분할 시 `tg_message_id` 하나로 부족 | §5.6, §16 | `tg_message_ids`(JSON 배열). `/cancel` 삭제는 배열 전체 |
| F-13 | 명확화 | 플랜 비활성이면 `last_plan_date`가 안 바뀌어 매 재시작·재개마다 만료 검사 반복 | §12, §6.2 | 플랜 비활성이어도 만료 검사 후 `last_plan_date` 갱신 |
| F-14 | 명확화 | `pool_create`가 상한에서 거부하지 않아 밤에 진행 중 항목이 만료될 수 있음. 설정 키 이름 불일치(`pool_max` vs `pool_max_pending`, `inbound_max` vs `inbound_max_pending`) | §7.2, §11, 부록 A | `pending+due >= pool_max_pending`이면 거부. 키 이름 통일 |
| F-15 | 문서 | `handle_reservation` 불릿이 `open_flow` 블록에 끊김 | §9 | 구조 정리 |
| F-16 | 명확화 | 디바운스 턴의 이벤트 블록 `memo`·`prompt` 출처 | §6.2 | 대기 중이던 self 예약의 `memo`, `flows.prompt` |
| F-17 | 명확화 | 불변식 (a)는 catchup 조준 중엔 "진입"이 아님, (d)는 보류·블랙아웃 처리 중 `fired` self를 허용해야 함 | §8 | 문구 갱신 |
| F-18 | 명확화 | 백오프 공식이 정리(§13.1)에만 있고 턴(§7.3)엔 없음 | §7.3 | 같은 공식 명시 |

---

## 5. 새 테스트 후보

F 항목 해결안을 전제로 한다.

| # | 상황 | 기대 |
|---|---|---|
| T-1 | paused + 블랙아웃 중 메시지 | 안내만, 저장 안 함 |
| T-2 | 전송 도중 사용자 메시지 | 버퍼(턴 커밋 후이므로 `id > answered_upto_id`), 디바운스 턴 |
| T-3 | `close_flow` 커밋 후 `finish()` 전 수신 | 인바운드 `pending`, `finish()`가 인바운드 예약 1개 생성 |
| T-4 | 흐름 없음 + `/pause` | `mode=paused`, 타이머 정지 |
| T-5 | 턴 실행 중 `/pause` | abort → 세대 불일치 폐기 → `close_flow('paused')`, 버퍼 `late` |
| T-6 | 흐름 없음 + `/cancel` | 안내만, 세대 카운터는 올라가도 무해 |
| T-7 | LLM 네트워크 오류(세대 일치) | 파싱 실패와 같은 실패 경로, 백오프 self |
| T-8 | 압축 실패 | 로그, 다음 턴 재시도, 흐름 영향 없음 |
| T-9 | `finish()`가 연 흐름의 첫 턴 중 `/cancel` | 세대 불일치 폐기, 곧이은 command가 `close_flow('cancelled')`, `finish()` 재진입 |
| T-10 | 보류 중 deadline 예약 발화 (F-2) | `fired` 유지, 흐름 안 엶, 해제 시 개시 |
| T-11 | 보류 중 열린 흐름의 self 발화 (F-2) | `fired` 유지, (d) 유지, 해제 시 재발화 |
| T-12 | 보류 해제(자정) | 재개 절차: deferred·플래그·버퍼·타이머 |
| T-13 | active·보류 중 `/resume` | `pause_reason=NULL`, 재개 절차 |
| T-14 | 흐름 중 deferred 후 블랙아웃 중 흐름 종료 (F-3) | deferred가 블랙아웃 끝으로 재예약, 즉시 개시 안 함 |
| T-15 | 블랙아웃 중 재시작 + 과거 `fired` main (F-3) | 블랙아웃 끝으로 재예약 |
| T-16 | `messages=[]` continue 후 재시작 (F-4) | 이미 답한 메시지 복원 안 함 |
| T-17 | `messages=[]` continue 후 블랙아웃 self 발화 (F-4) | 흐름 닫힘(`blackout`) |
| T-18 | 플랜 + 기존 main 예약 (F-5, 단일화 시) | 기존 `scheduled` main 교체 |
| T-19 | `23:00-07:00`, D+1 01:00 재시작 (F-6) | 플랜 재실행 안 함 |
| T-20 | `23:00-07:00`, D+1 23:00 진입 (F-6) | 플랜 실행 |
| T-21 | 플랜 파싱 2회 실패 (F-7) | `plan_retry_at` 백오프, 재시도, 상한 시 알림 |
| T-22 | 이틀 다운 후 블랙아웃 중 복구, outbox 있음 (F-8) | 오래된 것은 `undelivered`, 최근 것은 블랙아웃 끝에 전송 |
| T-23 | `/resume`, 사흘 지난 `scheduled` 예약 (F-8) | 폐기, 로그 |
| T-24 | `flow=end` 턴 전송 중 403 (F-9) | 정리 1회, `finish()` 안 함, `mode=paused` |
| T-25 | `/resume` 직후 과거 `scheduled` (F-1) | `flow_timer` 재조준으로 즉시 발화 |
| T-26 | deadline 예약의 prompt 파일 삭제됨 (F-11) | 예약 삭제·로그, 흐름 안 엶, 풀 항목 상태 불변 |
| T-27 | 인바운드 예약 발화 시 pending 0건(전부 만료) (F-11) | 예약만 삭제 |
| T-28 | 5000자 메시지 후 `/cancel` (F-12) | 분할된 두 메시지 모두 삭제 |
| T-29 | `plan-rules.md` 없음 (F-13) | 만료 검사 후 `last_plan_date` 갱신, 재시작 시 반복 안 함 |
| T-30 | 풀이 상한일 때 `pool_create` (F-14) | 거부 결과 |
| T-31 | 디바운스 턴 이벤트 블록 (F-16) | `memo`=대기 self의 memo, `prompt`=`flows.prompt` |

---

## 6. 결정이 필요한 항목

나머지(F-1~4, F-6, F-7, F-9~18)는 제안대로 반영하면 된다.

1. **F-5 main 누적**: (a) `main` 단일 예약(새 것이 교체) / (b) 이벤트 블록에 예약 목록 노출 / 둘 다.
2. **F-8 오래된 것들**: outbox·과거 예약을 `max_lead` 기준으로 폐기할지, 다른 기준(설정값 `stale_after_sec`)을 둘지.
3. **F-2 보류 모델**: 보류를 "자동 정지"로 보고 `/resume`과 같은 재개 절차를 쓸지(제안), 아니면 별도 의미를 둘지.
