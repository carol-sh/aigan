# docs

구현 기준은 `harness-design.md`(1.0) 하나다. 다른 문서를 참조하지 않고 그것만으로 구현할 수 있다.

## 구현에 필요한 것

| 파일 | 내용 |
|---|---|
| [`harness-design.md`](harness-design.md) | **정본(1.0).** 개체·불변식·이벤트·LLM 접점·실행 계층(§6)·DB 스키마(§8)·워커 의사코드(§9)·테스트 목록(§11) |
| [`figures/`](figures) | 정본에 실린 그림: 하루 예시(`harness-day`), 실행 모델(`harness-exec-model`), ERD(`harness-erd`). `.drawio`가 원본, `.png`는 렌더 결과 |

## 구현 참고

| 파일 | 내용 |
|---|---|
| [`notes/openai-adapter.md`](notes/openai-adapter.md) | `llm/` 구현용. OpenAI API 확인 결과(스파이크 대체), 실행기 구조, 가짜 클라이언트, 정본에 반영한 것 |
| [`plans/skeleton.md`](plans/skeleton.md) | 뼈대(LLM 없는 전부) 구현 계획. 코드 작성 원칙, 정본 이름→코드 이름, e2e 테스트 전략 |
| [`plans/flow-and-tools.md`](plans/flow-and-tools.md) | 2단계 흐름과 도구 구현 계획. 턴·정리의 io 밖 절반, 도구 검증, 각본 결정자로 하는 e2e |
| [`plans/llm-executor.md`](plans/llm-executor.md) | 3단계 LLM 실행기 구현 계획. 입력 조립·출력 스키마·도구 라운드·`llm_calls`, 각본 모델로 하는 e2e, 프롬프트 작성용 계약 |
| [`plans/turn-failure.md`](plans/turn-failure.md) | 4단계 턴 실패 구현 계획. 시도 선기록, `fail_turn`과 트리거 포기, 운영자 알림 |
| [`plans/gate.md`](plans/gate.md) | 5단계 게이트 구현 계획. 일일 상한·잔액 확인, 보류 진입과 알림, 잔액 해제 |
| [`plans/plan.md`](plans/plan.md) | 6단계 계획 실행기 구현 계획. 계획 입력·출력·커밋, 시각 범위와 상한, `plan-rules.md` 작성용 계약 |
| [`plans/compact.md`](plans/compact.md) | 7단계 압축 구현 계획. 압축 범위와 `answered_upto_id`, 턴·정리 입력의 요약, `compact-rules.md` 작성용 계약 |
| [`plans/adapters-cli.md`](plans/adapters-cli.md) | 8단계 어댑터·CLI 구현 계획. OpenAI·텔레그램 어댑터, `serve`·`reset`·`memory`, 실행 방법과 수동 스모크 절차 |
| [`plans/prompts.md`](plans/prompts.md) | 9단계 예시 프롬프트 세트. 파일별 책임, 자기 일 Agent와 알고리즘 노트 방침, 구조 테스트, 고칠 때 볼 것과 수동 스모크 체크리스트 |

## 프롬프트 작성용

하네스 구현에는 필요 없다. 프롬프트 본문(정본 §10)을 쓸 때 기준 장면으로 쓴다.

| 파일 | 내용 |
|---|---|
| [`prompting/harness-scenario-v4-evaluation.md`](prompting/harness-scenario-v4-evaluation.md) | 의심하고 평가하는 Agent |
| [`prompting/harness-scenario-agent-owner.md`](prompting/harness-scenario-agent-owner.md) | 자기 일을 하려고 사용자를 도구로 쓰는 매우 pushy한 Agent의 하루 |
| [`prompting/harness-scenario-agent-owner-shortcuts.md`](prompting/harness-scenario-agent-owner-shortcuts.md) | 같은 Agent의 다음 날. 꼼수 부리고 늘어지는 사용자를 혼내며 목표를 달성 |

## 기록 (구현에 필요 없음)

설계 과정의 문서다. 찾은 결함과 필요한 규칙은 모두 정본에 들어가 있다.

| 파일 | 내용 |
|---|---|
| [`archive/harness-design-v4.md`](archive/harness-design-v4.md) | 0.4. 1.0의 직전 판. 실행 계층 세부를 v3에 맡겼다 |
| [`archive/harness-design-v3.md`](archive/harness-design-v3.md) | v3. 1.0 §6의 실행 계층이 여기서 왔다 |
| [`archive/harness-scenario-v4.md`](archive/harness-scenario-v4.md) | 평범한 하루 추적 |
| [`archive/harness-scenario-v4-pushy.md`](archive/harness-scenario-v4-pushy.md) | 공격적인 프롬프트로 상한·비용 허점 찾기 |
| [`archive/harness-scenario-v4-profile.md`](archive/harness-scenario-v4-profile.md) | 일기 대신 묻는 프로파일링 |
| [`archive/harness-scenario-v4-inverted.md`](archive/harness-scenario-v4-inverted.md) | 인간-LLM 관계를 뒤집은 용도가 모델에 들어맞는지 검토 |
| [`archive/harness-trace.md`](archive/harness-trace.md) | v2.5 상태×이벤트 추적. v3.0에서 처리 완료 |
