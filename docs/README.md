# docs

구현 기준은 v4 설계 하나다. 나머지는 v4가 가리키는 참고 자료이거나, 설계 과정의 기록이다.

## 구현에 필요한 것

| 파일 | 내용 |
|---|---|
| [`harness-design-v4.md`](harness-design-v4.md) | **정본.** 개체·불변식·이벤트·LLM 접점·DB 스키마(§8)·워커 의사코드(§9)·테스트 목록(§11) |
| [`figures/`](figures) | v4에 실린 그림: 하루 예시(`harness-day`), 실행 모델(`harness-exec-model`), ERD(`harness-erd`). `.drawio`가 원본, `.png`는 렌더 결과 |
| [`reference/harness-design-v3.md`](reference/harness-design-v3.md) | v3. v4가 "v3 §N 그대로"로 넘긴 세부만 여기서 읽는다(아래 표) |

v4가 v3에 맡긴 부분:

| v3 | 내용 |
|---|---|
| §3, §5 | 스키마의 기준(v4 §8이 고친 것만 다름) |
| §5.7 | `llm_calls` 테이블 |
| §8.2 | 계획일 규칙(실행 시점, `plan_retry_at` 백오프) |
| §9.4 6단계 | outbox 전송: 분할, `send_interval`, 429, 403 |
| §9.6 | 보류 게이트와 `resume()` |
| §13.2 | 압축(gate 포함). 범위 제한은 v4 §9.4 |

## 프롬프트 작성용

| 파일 | 내용 |
|---|---|
| [`prompting/harness-scenario-v4-evaluation.md`](prompting/harness-scenario-v4-evaluation.md) | 프롬프트 본문(v4 §10의 6번)을 쓸 때 기준 장면. 하네스 구현에는 필요 없다 |

## 기록 (구현에 필요 없음)

설계를 검증하며 쓴 문서다. 찾은 결함은 v4에 반영됐고, 시나리오는 v4 §11.16 통합 테스트로 흡수됐다.

| 파일 | 내용 |
|---|---|
| [`archive/harness-scenario-v4.md`](archive/harness-scenario-v4.md) | 평범한 하루 추적 |
| [`archive/harness-scenario-v4-pushy.md`](archive/harness-scenario-v4-pushy.md) | 공격적인 프롬프트로 상한·비용 허점 찾기 |
| [`archive/harness-scenario-v4-profile.md`](archive/harness-scenario-v4-profile.md) | 일기 대신 묻는 프로파일링 |
| [`archive/harness-scenario-v4-inverted.md`](archive/harness-scenario-v4-inverted.md) | 인간-LLM 관계를 뒤집은 용도가 모델에 들어맞는지 검토 |
| [`archive/harness-trace.md`](archive/harness-trace.md) | v2.5 상태×이벤트 추적. v3.0에서 처리 완료 |
