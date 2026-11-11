# CHRONOS developer commands (milestone 1.1).
#
# Pipeline commands run with PYTHONPATH=pipeline/src instead of relying on the editable install's .pth file:
# on this Mac, files under .venv receive the macOS "hidden" flag and Python deliberately skips hidden .pth files.

PY := PYTHONPATH=pipeline/src uv run --no-sync python
SHA := shasum -a 256

.PHONY: setup fetch verify data test test-fast lint bench bench-quick reproducible

setup:            ## install Python (uv) and web (pnpm) dependencies at their locked versions
	uv sync --all-packages --frozen
	pnpm install --frozen-lockfile

fetch:            ## download the pinned inputs into data/raw and verify their sha256 (network)
	$(PY) -m chronos_pipeline fetch

verify:           ## re-check every pinned input against data/manifest.lock.json
	$(PY) -m chronos_pipeline verify

data:             ## run all QA rules and write the licence-gated public bundle to data/build/current
	$(PY) -m chronos_pipeline build --profile public

test:             ## every test, including the real-data reproduction of validation 0001 (needs `make fetch`)
	uv run --no-sync pytest pipeline/tests -q
	pnpm -r test

test-fast:        ## unit and synthetic end-to-end tests only (no data needed)
	uv run --no-sync pytest pipeline/tests -q -m "not data"
	pnpm -r test

lint:             ## ruff, mypy and TypeScript
	uv run --no-sync ruff check pipeline
	uv run --no-sync mypy --config-file pipeline/pyproject.toml pipeline/src
	pnpm -r typecheck

bench:            ## full engine benchmark in local Chrome (3 repetitions per engine); results in docs/spikes/results
	cd apps/web && node bench/run.mjs --reps 3 --label m2-chrome-headless

bench-quick:      ## 1-minute smoke run of the benchmark
	cd apps/web && node bench/run.mjs --reps 1 --picks 30 --step 50 --label quick

reproducible:     ## build twice and require byte-identical outputs
	mkdir -p data/staged
	$(PY) -m chronos_pipeline build --profile public > /dev/null
	cd data/build/current && $(SHA) * > ../../staged/build-1.sha256
	$(PY) -m chronos_pipeline build --profile public > /dev/null
	cd data/build/current && $(SHA) * > ../../staged/build-2.sha256
	diff data/staged/build-1.sha256 data/staged/build-2.sha256 && echo "byte-identical: $$(wc -l < data/staged/build-1.sha256) files"
