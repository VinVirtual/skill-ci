## skill-ci: `good-skill` passed

**0 errors, 0 warnings, 0 notices** across 8 checks in 0.3 s.

| Result | Check | Errors | Warnings | Details |
|---|---|--:|--:|---|
| ✓ pass | SKILL.md |  |  | SKILL.md |
| ✓ pass | README |  |  | README.md |
| ✓ pass | Licence |  |  | MIT |
| ✓ pass | Secrets and personal data |  |  | 11 files scanned |
| ✓ pass | Script safety |  |  | 6 files checked |
| ✓ pass | Media size budget |  |  | 1 media files, 0.00 MB of 15 MB |
| ✓ pass | Fresh-clone install test |  |  | `npm test` passed in 0.2 s |
| ✓ pass | Demo |  |  | 1 output file(s) |

### Fresh-clone install test

<details><summary>Test output: <code>npm test</code>, exit 0, 0.2 s</summary>

```text

> good-skill@1.0.0 test
> node --test

✔ greets by name (1.378322ms)
✔ falls back to world (0.160618ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 78.41235
```

</details>

### Demo

Demo outputs (uploaded as a workflow artifact): `out/hello.txt` (0.00 MB)

<details><summary>Demo output: <code>node scripts/hello.mjs out/hello.txt Ada</code>, exit 0, 0 s</summary>

```text
(no output)
```

</details>

<sub>skill-ci 0.1.0 · config: .skill-ci.yml · findings marked warning are worth a look, not proof of a problem</sub>
