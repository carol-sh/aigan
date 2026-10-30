# 7단계 구현 계획: 압축

## Context

하네스 로직 가운데 남은 것은 압축(§6.5)뿐이다.

지금 상태:
- DB 컬럼(`summary`, `compacted_until_id`), 설정(`flow_compact_chars`, `cleanup_raw_max_chars`), `compact-rules.md` 로딩, `llm_calls.kind='compact'`는 있다.
- 실행과 입력 반영은 없다. 그래서 흐름이 길어지면 턴 입력이 끝없이 커진다.

이번 단계는 정본 §6.5와 §9.4 끝의 "압축 검사"를 넣는다.
- 턴 입력의 흐름 대화를 "요약 + 압축하지 않은 구간 원문"으로 바꾼다.
- 정리 입력은 원문이 `cleanup_raw_max_chars`를 넘을 때만 같은 압축본으로 바꾼다(§5.3).

## 범위

**포함**
- 압축 검사: 턴이 커밋하고 전송한 뒤, 흐름이 열려 있을 때만 한다. 순서는 다음과 같다.
  - `compact-rules.md`가 없으면 하지 않는다.
  - 보류 중이면 하지 않는다.
  - 덮을 범위가 비면 하지 않는다.
  - 게이트를 거친다.
  - LLM에 요약을 받아 한 tx로 반영한다.
- 실패(API·파싱·예외)는 경고 로그만 남기고 상태를 바꾸지 않는다. 다음 턴 뒤 다시 시도한다.
- 압축 입력, 출력 파서, `LlmCompactDecider`. 도구는 없다(§5.6 표).
- 턴 입력과 정리 입력의 대화 절에 요약을 반영한다.
- 각본 모델과 rig가 압축을 지원하게 한다. 실행기의 `tool_choice` 버그도 고친다(아래).
- 테스트: 88, 89, 89a, 89b, 89c, 90(압축), 90b, 12c(압축), 압축 게이트, 규칙 파일 없음.

**제외**
- 어댑터·CLI는 다음 단계다.
- `compact-rules.md` 본문은 프롬프트 작업이다. 계약만 문서에 남긴다.

## 코드 작성 원칙 (이전 계획에서 이어짐)

- **이름:** 함수는 동사구, 불리언은 `is`/`has`, 시각은 `...At`로 쓴다.
- **주석:** 이유에만 단다. 이번 단계의 예:
  - 왜 `answered_upto_id`에서 멈추는가
  - 왜 전송 뒤에 압축하는가
  - 왜 보류 중이면 건너뛰는가
- **모양:** 정리·계획과 같다. worker에 `CompactDecider` 인터페이스와 `compactOpenFlowIfLong`을 두고, llm의 `LlmCompactDecider`가 입력을 조립해 대화한다. SQL은 저장소 안에만 둔다.
- **테스트:** 이름은 정본 번호와 상황, 본문은 상황 → 행동 → 기대 순이다.

### 정본 이름 → 코드 이름

| 정본 | 코드 |
|---|---|
| 압축 검사(§9.4 끝) | `compactOpenFlowIfLong(ctx, decider)` (`worker/compact.ts`) |
| 비압축 구간 | `findUncompactedMessages(ctx, flow)` |
| 압축 범위 | `chooseMessagesToCompact(flow, messages, config)` |
| 반영 | `flows.saveSummary(flowId, summary, compactedUntilId)` (새 쿼리) |
| 압축본 | `ConversationView { summary, messages }`. 턴·정리 입력이 함께 쓴다 |

## 설계 결정

### 어디서 도는가

```
runTurn():
  … commitTurn(…)
  await sendOutbox(ctx)            # 압축은 전송 뒤. 사용자가 압축 호출을 기다리지 않는다
  await compactOpenFlowIfLong(ctx, compactDecider)
```

- 정본 §9.4대로 턴 작업 안에서 돈다. 따로 고르는 작업으로 만들지 않는다. 그러면 "다음 턴 뒤 재시도"에 별도 상태가 필요하다.
- 커밋한 턴 뒤에만 돈다. 실패했거나 보류에 막힌 턴은 앞에서 돌아간다.
- `runTurn`이 `sendOutbox`를 부른다. 루프도 작업 뒤에 다시 부르지만, 그때는 보낼 것이 없어 아무 일도 하지 않는다.
- `runTurn(ctx, deciders, task)`의 `deciders`는 `{ turn, compact }`로 바꾼다. 부르는 곳은 `boot`뿐이다.

### 압축 검사

```
compactOpenFlowIfLong():
  if not prompts.compactRules: return
  f = 열린 흐름; if not f: return
  if hold_reason: return          # 전송 중 403으로 막 차단 보류에 들어갔을 수 있다. 게이트는 기존 보류를 보지 않아
                                  # 그대로 두면 일일 상한 보류를 겹쳐 넣고 알림을 또 보낸다
  messages = findUncompactedMessages(f)          # flow_id=f, void_reason IS NULL, id > compacted_until_id(NULL이면 0)
  targets = chooseMessagesToCompact(f, messages)
  if targets 비었음: return                      # 89c
  if await holdIfOutOfBudget(ctx): return
  try summary = await decider.decide({ flowId, previousSummary: f.summary, messages: targets })
  catch: logger.warn("흐름 N의 압축이 실패했다"); return
  tx{ flows.saveSummary(f.id, summary, targets.at(-1).id) }
```

범위 고르기(§6.5, §9.4):

```
total = Σ len(content); if total <= flow_compact_chars: []
goal = flow_compact_chars / 2
for m in messages (id 순):
  if m.id > f.answered_upto_id: break            # 미응답과 그 뒤는 덮지 않는다
  take m; total -= len(m)
  if total <= goal: break
```

- 최소 1개 조건은 첫 메시지를 덮을 수 있으면 저절로 지켜진다.
- 문자 수는 JS 문자열 길이다.
- 정본이 "남은 구간"을 무엇으로 재는지는 정하지 않았다. 비압축 구간 원문의 길이로 잰다. 요약 길이는 넣지 않는다. 요약은 다음 압축 때 새 요약으로 교체되므로 쌓이지 않는다.

### 출력 계약

```json
{ "summary": "기존 요약과 대상 대화를 합친 새 요약" }
```

- `summary`가 빈 문자열이면 형식 위반이다. 1회 재시도하고, 그래도 틀리면 압축 실패다(로그만).
- 새 요약은 기존 요약을 **교체**한다. 그래서 규칙 파일이 "기존 요약을 포함해 다시 써라"를 말해야 한다(계약 문서에 적는다).

### 압축 입력

system은 `compact-rules.md` 전문이다. user 문서는 다음과 같다.

```
## 기존 요약
(없음)

## 줄일 대화
[10:00] 사용자: …
[10:00] 나: …
```

- 정본 입력은 "규칙, 기존 summary, 대상 메시지"뿐이라 그것만 넣는다.
- 메시지 줄은 턴·정리와 같은 `renderMessages`로 그린다.
- 도구는 없다. `maxToolRounds`는 0이다.

### 실행기 수정: 도구 없는 호출의 `tool_choice`

- 지금 `#request`는 강제 호출이면 도구가 없어도 `tool_choice: "none"`을 넣는다.
- 압축은 도구가 없어서 첫 호출과 파싱 재시도가 모두 강제 호출이다. 실제 API는 도구 없이 `tool_choice`를 주면 거부할 수 있다.
- 그래서 `tools`가 있을 때만 `tool_choice`를 넣는다. 턴·정리·계획은 도구가 있으므로 바뀌지 않는다.

### 대화 보기 (턴·정리 공용)

```ts
interface ConversationView { summary: string | undefined; messages: Message[] }
```

- **턴 입력:**
  - `흐름 대화` 절은 `renderConversation(view)`로 그린다. 요약이 있으면 맨 앞에 `[요약] 첫 줄`을 두고, 나머지 줄은 4칸 들여 쓴다. 메시지와 같은 모양이다.
  - `lastShownUserMessageId`는 원문으로 넣은 메시지에서만 센다. 정본 그대로이고, 89b가 이것을 본다.
  - 직전 흐름 꼬리의 기준 시각은 압축과 무관하게 **흐름의 첫 메시지** 시각이다. 그래서 전체 흐름 메시지의 첫 것을 따로 쓴다.
- **정리 입력:** 원문 전체의 문자 수가 `cleanup_raw_max_chars` 이하면 원문 전체를 준다(압축된 구간 포함, 90a). 넘으면 턴과 같은 압축본을 준다(90b). 압축한 적 없는 흐름은 압축본도 원문 전체다.
- 프롬프트 계약 문서의 입력 예시에 `[요약]` 줄을 더한다.

### 각본 모델과 rig

- `kindOf`가 도구가 없는 요청을 `compact`로 읽는다.
- `onCompact(...scripts)`를 둔다. 각본이 다 떨어지면 기본으로 `summarize("요약")`을 낸다.
- `ScriptedCompaction`:
  - `summarize(text)`
  - `fail()`: API 오류
  - `malformed()`
- `llmTasks` 라벨은 `compact`이고, `inputs`·`requestsOf`·`lastInput`이 `"compact"`도 받는다.
- `StartOptions.compactRules?: boolean`. 기본은 `false`다. 기존 테스트는 압축이 끼지 않아 그대로다. `true`면 `compact-rules.md`를 쓴다.

### 저장소

`flows.saveSummary(flowId, summary, compactedUntilId)` 하나를 더한다. 메시지 조회는 기존 `findShownInFlow`를 쓰고 비압축 구간은 코드에서 거른다.

## 파일

```
src/
├── db/repositories/flows.ts        # + saveSummary
├── llm/
│   ├── conversation.ts             # 도구가 있을 때만 tool_choice
│   ├── outputs.ts                  # + parseCompactOutput
│   ├── compact-decider.ts          # 새로: LlmCompactDecider
│   └── input/
│       ├── compact-input.ts        # 새로: renderCompactInput
│       ├── transcript.ts           # + ConversationView, renderConversation
│       ├── turn-input.ts           # 흐름 대화 = 요약 + 비압축 구간, 꼬리 기준은 흐름의 첫 메시지
│       └── cleanup-input.ts        # 원문이 상한을 넘으면 압축본
└── worker/
    ├── compact.ts                  # 새로: CompactDecider, compactOpenFlowIfLong, findUncompactedMessages, chooseMessagesToCompact
    ├── turn.ts                     # 커밋 뒤 전송·압축, deciders 객체
    └── boot.ts                     # LlmCompactDecider 연결
test/
├── fakes/scripted-llm.ts           # onCompact, ScriptedCompaction, kindOf compact
├── rig.ts                          # compactRules 옵션
└── spec/11.11-compact.test.ts      # 새로
docs/plans/compact.md               # 이 계획 + 구현 결과 + compact-rules.md 계약. README 링크, llm-executor.md의 계약에 [요약] 줄
```

## 이번 단계 테스트 (`11.11-compact.test.ts`)

모두 `compactRules: true`이고, `flow_compact_chars`는 작게(예: 60) 둔다.

| # | 넣는 것 |
|---|---|
| 88 | 답장 턴 뒤 비압축 구간이 임계를 넘으면 압축이 돈다. `summary`와 `compacted_until_id`를 확인한다. 범위는 남은 구간이 임계/2 이하가 되는 첫 지점이다. 다음 턴 입력의 `흐름 대화`는 `[요약] …`과 비압축 메시지뿐이다. 두 번째 압축 입력의 `기존 요약`에는 첫 요약이 들어간다 |
| 89 | 압축이 실패하면 경고 로그를 남기고 요약은 그대로다. 그 턴은 정상으로 커밋되고 전송된다. 다음 턴 뒤 다시 압축해 성공한다 |
| 89a | 턴 io 중에 온 메시지를 지우지 못해 미응답(`id > answered_upto_id`)으로 남는다. 압축 범위는 그 앞에서 멈춘다(`compacted_until_id` < 그 id). 다음 답장 턴 입력에 그 메시지가 원문으로 있다 |
| 89b | 압축이 흐름의 user 메시지를 모두 덮은 뒤 이어가기 턴이 돈다. 입력 원문에 user 줄이 없고, `answered_upto_id`가 그대로이며, 뒤이어 답장 턴이 골라지지 않는다 |
| 89c | AI 개시 턴의 긴 말로 임계를 넘지만 `answered_upto_id`=0이라 덮을 메시지가 없다. 압축 호출이 없다(`llm_calls`에 compact 없음) |
| 90(압축) | 압축 요청에 `tools`가 없고 `tool_choice`도 없다. system은 `compact-rules.md`다. `llm_calls`는 `kind='compact'`, `flow_id`=흐름이다 |
| 90b | 압축된 흐름의 정리를 본다. 원문이 `cleanup_raw_max_chars` 이하면 원문 전체를 주고(요약 없음), 넘으면 `[요약]`과 비압축 구간을 준다 |
| 12c(압축) | 압축 io 중에 온 메시지는 지우지 않고 그 흐름의 미응답으로 들어간다. 디바운스 뒤 답장 턴이 받는다 |
| 게이트 | 턴이 상한을 다 쓴 뒤 압축이 필요하면, 압축 게이트가 보류에 들어간다. 압축 호출은 없고 알림은 1번이다 |
| 규칙 없음 | `compact-rules.md`가 없으면 임계를 넘어도 압축 호출이 없다 |

## 테스트 계획 자체 검증

| 처음 생각 | 문제 | 고친 것 |
|---|---|---|
| 88을 "요약이 생김"으로만 확인 | 범위를 통째로(미응답 앞까지 전부) 덮어도 통과한다 | `compacted_until_id`를 정확한 id로 본다. 메시지 길이를 골라 임계/2 경계가 중간에 오게 한다 |
| 88에서 입력 반영을 안 봄 | 요약을 저장만 하고 턴 입력에 안 써도 통과한다 | 다음 턴의 `흐름 대화` 절을 본다 |
| 기존 요약 전달을 안 봄 | 매번 새로 요약해 이전 내용을 잃어도 통과한다 | 두 번째 압축 입력의 `기존 요약` |
| 89a를 범위만 확인 | 범위를 멈춰도 입력에서 그 메시지를 빼면 같은 고리가 생긴다 | 다음 턴 입력에 원문으로 있는지 본다 |
| 89b를 "reply 없음"으로만 | `answered_upto_id`가 0으로 돌아가도 이어가기 커밋 직후엔 안 드러날 수 있다 | `answered_upto_id` 값을 직접 본다 |
| 89를 "로그 남음"으로만 | 실패가 턴 커밋을 되돌리거나 루프를 깨도 모른다 | 그 턴의 전송과 다음 턴 뒤 재시도를 본다 |
| 게이트를 안 봄 | 압축이 게이트를 건너뛰면 상한이 새고, 보류 중 검사가 없으면 알림이 겹친다 | 게이트 테스트. 403 뒤 겹침은 `hold_reason` 검사로 막고 코드 주석으로 남긴다 |
| 90b를 넘는 경우만 | 상한 안에서도 압축본을 주면 정본(원문 우선)과 다르다 | 두 경우 다 본다 |

남는 한계: 요약의 질과 길이는 프롬프트와 실제 모델에 달렸다. 하네스는 요약 길이를 제한하지 않는다(정본에 없음).

## 순서 (커밋 단위)

1. **압축 실행과 입력 반영:** `compact.ts`, 결정자, 입력, 파서, `saveSummary`, `runTurn` 연결, 턴·정리 대화 보기, `tool_choice` 수정, 각본 모델·rig. 기존 테스트는 바뀌지 않아야 한다.
2. **압축 e2e:** 위 표.
3. **문서:** `docs/plans/compact.md`(계획 + 구현 결과 + `compact-rules.md` 계약), `docs/README.md` 링크, `llm-executor.md` 계약의 흐름 대화·정리 대화에 `[요약]` 줄.

단계마다 `pnpm check`를 통과시키고 커밋·push한다.

## 검증

- `pnpm check`가 통과해야 한다. 지금은 254개다.
- 기존 테스트의 기대값은 바뀌지 않아야 한다. 압축은 규칙 파일이 있을 때만 돌고 rig 기본은 없음이다. `tool_choice` 수정은 도구 없는 호출에만 닿는다.
- 손으로 따라가 볼 예(88): `flow_compact_chars`=60.
  - 사용자 20자 → 턴 20자 → 사용자 20자 → 턴 20자. 합이 80이라 60을 넘는다.
  - 목표는 30 이하다. 앞에서 셋을 덮으면 남는 것은 20이다.
  - 그래서 `compacted_until_id`는 셋째 메시지 id다. 셋째는 `answered_upto_id` 이하다.

## 정본 대조

§5.3, §5.4, §5.6, §6.3(게이트), §6.5, §8.3, §9.4(압축 검사·`answered_upto_id`), §11.2의 12c, §11.11의 88–90b와 대조했다.
- **정본과 같게 둔 것:**
  - 전송 뒤, 열린 흐름만
  - 미응답에서 멈춤, 덮을 게 없으면 호출 없음
  - 실패는 로그만, 다음 턴 뒤 재시도
  - 게이트를 거침
  - 도구 없음
  - 정리는 상한을 넘을 때만 압축본
- **정본이 정하지 않아 정한 것** (문서에 남긴다):
  - 출력 키 `summary`, 새 요약은 기존 요약을 교체
  - 남은 구간은 원문 길이로 잼(요약 길이 제외)
  - 보류 중이면 압축 검사를 건너뜀
  - 압축 입력 절 이름(`기존 요약`, `줄일 대화`)
  - 요약 줄 표기 `[요약]`

## 프롬프트 작성용 계약

`compact-rules.md`를 쓸 때 기준이다. 이 파일이 없으면 압축하지 않는다.

**입력**: system은 `compact-rules.md` 전문이다. user 문서는 다음과 같다.

```
## 기존 요약
(없음)                                  # 앞서 압축했으면 그 요약

## 줄일 대화
[10:00] 사용자: …
[10:00] 나: …
```

**출력** (`response_format: json_object`)

```json
{ "summary": "새 요약" }
```

- 새 요약은 기존 요약을 **교체**한다. 기존 요약의 내용을 버리지 않으려면 규칙이 "기존 요약과 줄일 대화를 합쳐 다시 써라"를 말해야 한다.
- 빈 요약은 형식 위반이다. 한 번 더 묻고, 그래도 틀리면 이번 압축은 건너뛴다(다음 턴 뒤 다시).
- 도구는 없다.

**요약이 보이는 곳**: 턴의 `## 흐름 대화` 맨 앞 줄에 `[요약] …`으로 들어간다(여러 줄이면 4칸 들여쓰기). 정리는 원문이 `cleanup_raw_max_chars`를 넘을 때만 `## 대화`에서 같은 모양으로 본다. 그래서 요약은 턴이 대화를 잇는 데 필요한 것(무엇을 시켰고, 사용자가 무엇을 냈고, 어떻게 판정했는지)을 남겨야 한다. 사용자 분석은 정리가 원문으로 한다.

## 구현 결과

계획한 커밋 단위대로 들어갔다. `pnpm check`는 테스트 264개로 통과한다. 기존 테스트의 기대값은 바뀌지 않았다. 알아둘 점은 아래와 같다.

- **변이 확인:** 아래 코드를 일부러 망가뜨려 보고 테스트가 잡는지 확인했다.
  - `answered_upto_id`에서 멈추지 않게 하면 89a, 89b, 89c가 깨진다.
  - 압축의 게이트를 빼면 게이트 테스트가 깨진다.
  - 정리가 늘 압축본을 쓰게 하면 90b가 깨진다.
- **잡히지 않는 변이 하나:** 턴이 답한 것으로 커밋하는 범위(`upto`)를 압축된 구간까지 포함해 세도 테스트가 깨지지 않는다. 압축된 user 메시지의 id는 이미 `answered_upto_id` 이하이고 커밋이 `MAX`로 갱신하므로 결과가 같다. 해가 없어서 테스트를 더하지 않았다.
- **`runTurn`이 전송을 부른다.** 압축이 전송 뒤에 와야 해서다. 루프의 작업 뒤 전송은 그대로 두었다(보낼 것이 없으면 아무것도 하지 않는다).
- **`tool_choice` 수정**은 도구 없는 요청(압축)에만 닿는다. 턴·정리·계획 요청은 바뀌지 않았다.
- **로그 문구:** `흐름 <id>의 압축이 실패했다. 다음 턴 뒤 다시 한다` (warn)
