# docs

구현 기준은 `harness-design.md`(1.0) 하나다. 다른 문서를 참조하지 않고 그것만으로 구현할 수 있다.

## 구현에 필요한 것

| 파일 | 내용 |
|---|---|
| [`harness-design.md`](harness-design.md) | **정본(1.0).** 개체·불변식·이벤트·LLM 접점·실행 계층(§6)·DB 스키마(§8)·워커 의사코드(§9)·테스트 목록(§11) |
| [`figures/`](figures) | 정본에 실린 그림: 하루 예시(`harness-day`), 실행 모델(`harness-exec-model`), ERD(`harness-erd`). `.drawio`가 원본, `.png`는 렌더 결과 |

## 프롬프트 작성용

하네스 구현에는 필요 없다. 프롬프트 본문(정본 §10)을 쓸 때 기준 장면으로 쓴다.

| 파일 | 내용 |
|---|---|
| [`prompting/harness-scenario-v4-evaluation.md`](prompting/harness-scenario-v4-evaluation.md) | 의심하고 평가하는 Agent |
| [`prompting/harness-scenario-agent-owner.md`](prompting/harness-scenario-agent-owner.md) | 자기 일을 하려고 사용자를 도구로 쓰는 매우 pushy한 Agent의 하루 |

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
