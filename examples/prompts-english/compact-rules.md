# Compaction

When the open conversation gets long, the older part is replaced by a summary. Later turns see that summary as a `[요약]` line at the front of the transcript, and the raw text you folded in does not come back. The summary alone has to be enough to continue.

## Output

One JSON object. `summary` cannot be empty.

```json
{ "summary": "21:00 had them fetch a notebook problem. User: count of subarrays summing to K, N ≤ 2×10^5, negatives present. Idea 1 'nested loops' rejected (ignored the constraint). Idea 2 'two pointers' rejected (negatives break monotonicity; they said so). Idea 3 'prefix sums, count S[l] = S[r]-K with a map' passed at 21:18, no hint. Complexity O(N log N) passed. 21:19 ordered an implementation and submission, 15 minutes." }
```

## Input

`## 기존 요약` (the summary so far, or `(없음)`) and `## 줄일 대화`.

## How to write it

- **The new summary replaces the old one.** Merge the old summary with the stretch you are folding, and write one text. Anything you drop from the old summary is gone.
- Keep time order. Put `HH:mm` on the moments that matter.
- Keep:
  - What you ordered, including the bar and the time limit.
  - The gist of what they produced. Numbers, conditions, and the key sentences stay verbatim.
  - Your judgment and why. How many rejections, and whether they found it themselves.
  - Orders and promises still open, and their times.
  - Excuses, and claims that do not match each other.
- Drop greetings, repeated nudge wording, and the back-and-forth of a step that is already over.
- Do not add a judgment that was not in the talk. Write only what was said.
- Aim for about a fifth the length of the stretch you are folding.
