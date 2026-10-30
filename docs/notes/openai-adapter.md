# OpenAI 어댑터 참고

`llm/` 구현 때 참고한다. otsu(`carol-sh/otsu@e0f7f0c`)의 `src/llm/`와 그 스파이크 기록(`docs/notes/llm-contract.md`)에서 aigan에 필요한 것만 옮겼다. provider는 OpenAI로 가정한다. DeepSeek은 확인하지 않았다(맨 아래).

## 스파이크에서 확인된 것 (OpenAI Chat Completions, 2026-10-27)

| 항목 | 결과 |
|---|---|
| `tools`와 `response_format: json_object`를 한 요청에 | 된다. 도구 라운드에서는 `finish_reason: tool_calls`, 도구 결과를 준 뒤에는 `stop`과 파싱되는 JSON 객체 |
| 강제 호출(`tools` 유지 + `tool_choice: "none"`) | 도구를 부르지 않고 JSON 객체를 준다. prefix가 같아 캐시가 산다(1887 중 1792 토큰 캐시) |
| `tools`를 뺀 강제 호출 | `cached_tokens: 0`. 도구 정의가 캐시 prefix에 들어간다. 그래서 강제 호출도 `tools`를 빼지 않는다 |
| `gpt-6-luna` + `reasoning_effort: low` + `tools` | **400 거부.** "Function tools with reasoning_effort are not supported ... use /v1/responses or set reasoning_effort to 'none'" |
| `gpt-6-luna` + `reasoning_effort: none` | 위 항목 전부 된다. 추론 토큰 0, 출력 20–44 토큰 |
| `gpt-5-mini`(기본 effort) | `tools`와 `json_object`를 함께 쓸 수 있다. 추론 토큰이 호출마다 64–384로 출력 대부분 |
| 캐시 읽기 / 쓰기 필드 | `usage.prompt_tokens_details.cached_tokens` / `usage.prompt_tokens_details.cache_write_tokens`(첫 호출에서 prefix 전체) |
| 빈 응답 | 관찰되지 않음 |

모델이 형식을 어긴 사례: 시각 필드에 `"아침"`이나 빈 문자열을 넣고, 필수 필드를 비웠다. 스파이크 프롬프트가 형식을 말하지 않아서다. 턴 규칙에 ISO 8601 형식(오프셋 포함)과 예시, 필수 여부를 적는다. 위반은 파싱 실패로 처리한다(§5.4).

## 정본에 반영할 것

1. **LLM 포트는 SDK 모양 하나로 둔다.** `ChatClient { create(params): Promise<ChatCompletion> }`. 가짜는 completion을 각본으로 준다. 도구 라운드·강제 호출·재시도·`llm_calls` 기록이 실제 코드로 테스트된다(§6.7 `ports.ts`의 `Llm`을 이것으로).
2. **`reasoning_effort` 설정 키.** 비어 있으면 요청에 넣지 않는다(§9.9).
3. **`llm_calls.error`.** API 오류(`api: ...`)와 파싱 실패(`parse: ...`)를 구분해 남긴다(§8.6). 캐시 쓰기 토큰도 남기려면 `cache_write_tokens` 컬럼.
4. **SDK 재시도 끔.** `new OpenAI({ maxRetries: 0 })`. 백오프는 §6.2가 맡는다.

## 구조

```ts
// client.ts — 하네스가 하는 유일한 API 호출
export interface ChatClient {
  create(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;
}

export function createChatClient(apiKey: string, baseURL?: string): ChatClient {
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
  return { create: (params) => client.chat.completions.create(params) };
}
```

호출 하나의 명세. 턴·계획·정리·압축이 같은 실행기를 쓰고 도구·파서·상한만 다르다.

```ts
interface CallSpec<T> {
  kind: "turn" | "plan" | "cleanup" | "compact";
  flowId: number | null;
  messages: readonly ChatCompletionMessageParam[];
  tools: readonly ChatCompletionFunctionTool[];
  maxToolRounds: number;        // max_tool_rounds / max_cleanup_tool_rounds
  runTool: ToolRunner;          // (name, args) => string. 동기. 쓰기는 TurnTx·MemoryTx에 모은다
  parse: OutputParser<T>;       // (text) => {ok, value} | {ok:false, error}. zod
}
type CallResult<T> = { ok: true; value: T; raw: string } | { ok: false; error: string };
```

## 실행기 흐름

```
run(spec):
  messages = spec.messages 복사
  for round = 0..:
    forced = round >= maxToolRounds
    reply = send(messages, forced)              # API 오류면 바로 실패 반환
    if not forced and reply.tool_calls 有:
      messages += assistant(tool_calls), 각 호출의 tool 메시지(runTool 결과)
      continue
    r = parse(reply.content)
    if r.ok: return r
    retry = send(messages, forced=true)         # 파싱 실패 1회 재시도. 강제 호출로
    return parse(retry.content)

send(messages, forced):
  params = { model, messages, response_format: json_object,
             reasoning_effort?(설정에 있을 때만),
             tools?(있을 때만) + tool_choice: "none"(forced일 때만) }
  daily_calls += 1                              # 요청마다. 게이트는 작업 단위로 run 앞에서(§6.3)
  try completion = client.create(params); error = judge(message)
  catch → error = "api: ..."
  llm_calls 행 기록(request·response JSON, 토큰, latency, ok, error)
```

- `judge`: 도구 라운드에서 `tool_calls`가 있으면 정상. 그 밖에는 `parse`해 보고 실패 사유를 `parse: ...`로 남긴다. 기록만 하고 흐름은 위 루프가 정한다.
- 도구 실행:
  - 인자가 JSON이 아니면 "도구 인자가 json이 아니다."를 결과로 돌려준다(예외로 끊지 않는다).
  - `type !== "function"`이면 "이 형식의 도구는 없다.".
  - 없는 이름이면 "`<name>` 도구는 없다.".
  - 도구 결과는 모두 문자열이고, 거부도 문자열로 알려 모델이 고치게 한다(§9.5).
- 다시 보낼 assistant 메시지는 `{ role: "assistant", content, tool_calls }`만 담는다.
- 도구 정의는 `parameters`에 `additionalProperties: false`, `required`를 둔다.

## 토큰 읽기 (OpenAI)

```ts
const details = usage.prompt_tokens_details ?? {};
const cached = details.cached_tokens ?? 0;
input_tokens  = usage.prompt_tokens        // 캐시 포함 전체
cached_tokens = cached
cache_write   = details.cache_write_tokens ?? null
output_tokens = usage.completion_tokens
```

`usage`가 없으면 모두 null. SDK 타입에 없는 필드라 `Record<string, unknown>`으로 읽는다.

## 가짜 클라이언트 (테스트)

```ts
type ScriptedReply = ChatCompletion | Error | Promise<ChatCompletion>;

function fakeChat(script: ScriptedReply[]) {
  const queue = [...script];
  const requests: ChatCompletionCreateParamsNonStreaming[] = [];
  return {
    requests,                                    // 받은 요청 전부. 입력 조립 검증에 쓴다
    async create(params) {
      requests.push(structuredClone(params));
      const next = queue.shift();
      if (!next) throw new Error("fake chat script ran out");
      if (next instanceof Error) throw next;     // API 오류 주입
      return next;                               // Promise면 테스트가 풀 때까지 붙잡는다
    },
  };
}
// textReply(content) → finish_reason "stop"
// toolReply({name, args}, ...) → content null, tool_calls[i].id = `call_${i}`, finish_reason "tool_calls"
// usage는 prompt 100 / completion 10 / cached 80 고정
```

Promise 응답은 "LLM 호출 도중 메시지가 들어오는" 경우(§11.6 등)를 재현하는 데 쓴다.

## 수동 스모크

어댑터는 단위 테스트가 없다. 실물 키로 아래를 한 번 돌려 확인한다(5단계).

- 버리는 데이터 디렉터리와 `:memory:` DB를 쓴다. 예시 프롬프트와 방침을 넣는다.
- 실제 턴을 한 번 돌린다. 결과 JSON이 스키마를 통과하는지 본다.
- 대화를 저장하고 사용자 답을 하나 넣은 뒤, 정리 호출을 한 번 돌린다. 기억 쓰기 결과를 출력한다.
- `llm_calls`와 `daily_calls`를 출력한다.

## DeepSeek (미확인)

쓰게 되면 그때 확인한다.

- `tools`와 `json_object`를 동시에 쓸 수 있는지.
- 캐시 필드. otsu는 `usage.prompt_cache_hit_tokens`·`prompt_cache_miss_tokens`로 읽는다.
- 잔액 API(§6.3 게이트).
- 모델 ID.
