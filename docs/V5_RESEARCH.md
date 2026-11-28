# V5 – Nghiên cứu xếp hạng Giải 8 (2026-11-28)

**Trạng thái: thử nghiệm, chưa thay V4, không phải dự báo đã kiểm định.**

Nguồn `data/results.json` tại commit 13278d9, 690 ngày, 2169 lượt theo đài, 2025-01-01 đến 2026-11-23. Chuẩn hóa tp-hcm -> ho-chi-minh (198 kỳ, không trùng/xung đột), 21 đài. Chỉ Giải 8. Tối thiểu 20 kỳ riêng đài. Không dùng dữ liệu cùng ngày hoặc tương lai, kể cả trọng số mô hình và prior liên đài. Chia 2026-06-01: 1196 lượt trước mốc, 553 lượt sau mốc. Mốc và dữ liệu đã được nghiên cứu cho V4, nên cả hai giai đoạn đều là exploratory, không phải test độc lập chưa từng xem. V4 được tái hiện công thức, quy tắc hòa điểm trong script là số tăng dần, khác tie-break production. So sánh trên cùng tập lượt; số lượt khác báo cáo MySQL trước đây.

## Expert và ensemble

- Uniform: 1/100.
- V4: cấu hình mặc định.
- Bayes frequency: Dirichlet alpha=2 trên 100 lớp.
- Digit marginals: tích hai phân phối chữ số alpha=3.
- Partial pooling: (count riêng đài + 200 * prior các đài khác) / (n + 200); prior Dirichlet alpha=5.
- Digit Markov: chuyển trạng thái bậc 1 riêng đầu/đuôi, alpha=3.
- Fixed: trọng số [0.5,0.1,0.1,0.1,0.1,0.1].
- Adaptive: cùng prior, cập nhật log weight += 0.25 * log(p(actual)/0.01) sau khi toàn bộ kỳ trong ngày đã kết thúc; chuẩn hóa softmax. Không fit trọng số trên kết quả cùng ngày.

## Kết quả chạy nghiên cứu

| Model | Top5 trước mốc | Top5 sau mốc | Hạng TB sau mốc | Khoảng cách TB tới Top5 | Log loss sau mốc |
|---|---:|---:|---:|---:|---:|
| V4 | 60/1196 | 36/553 (6.51%) | 50.16 | 45.32 | 4.61464 |
| Bayesian frequency | 68/1196 | 31/553 (5.61%) | 50.61 | 45.72 | 4.65721 |
| Digit marginals | 50/1196 | 28/553 (5.06%) | 49.64 | 44.73 | 4.65925 |
| Partial pooling | 58/1196 | 34/553 (6.15%) | 51.75 | 46.85 | 4.67855 |
| Digit Markov | 55/1196 | 17/553 (3.07%) | 53.58 | 48.64 | 4.68446 |
| Fixed ensemble | 58/1196 | 26/553 (4.70%) | 51.37 | 46.45 | 4.61486 |
| Adaptive ensemble | 55/1196 | 36/553 (6.51%) | 50.15 | 45.31 | 4.60517 |
| Uniform theoretical | 5% | 5% | 50.5 | 45.6 | 4.60517 |

Distance = max(0, rank - 5); lower is better. Adaptive ends with uniform weight 99.98356%, so a rank list from tiny residual differences does not establish a meaningful edge. No candidate exceeds V4 on later Top5. Keep V4; retain uniform baseline. The 5% reference is consistent with uncertainty at this sample size.

## Reproduce
`npm run benchmark:v5` or `node src/prize8-v5-research.js data/results.json 2026-06-01`.
Results were computed in a JS analysis runtime using the same formulas; CI for the committed script must be checked separately.

## Next gate
Freeze models before new data; append later draws without changing prior predictions, compare Top5, mean distance, mean rank, MRR, log loss and Wilson interval. Consider tests for independence, multiple-comparison control and coverage. Do not switch production unless new evidence supports repeatable improvement. No guaranteed winning claim.

## References
- https://otexts.com/fpptr/tscv.html
- https://pmc.ncbi.nlm.nih.gov/articles/PMC9718476/
- https://pmc.ncbi.nlm.nih.gov/articles/PMC7996321/
- https://doi.org/10/c6758w
- https://academic.oup.com/jrsssa/article-abstract/160/2/187/7102439
