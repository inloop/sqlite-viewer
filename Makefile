.PHONY: deps clean-deps dist release

# Download the pinned third-party assets (see scripts/fetch-assets.sh).
deps:
	@scripts/fetch-assets.sh

# Remove the downloaded assets and built output, restoring the tree to its
# checked-in state. Uses git's ignore rules so it never touches tracked files.
clean-deps:
	@git clean -fX css js dist

# Assemble the deployable site in dist/ (run `make deps` first).
dist:
	@scripts/build-dist.sh

# Build a deployable zip (run `make deps` first to fetch the third-party assets).
release:
	@scripts/build-release.sh
