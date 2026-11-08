.PHONY: deps clean-deps

# Download the pinned third-party assets (see scripts/fetch-assets.sh).
deps:
	@scripts/fetch-assets.sh

# Remove the downloaded assets, restoring the tree to its checked-in state.
# Uses git's ignore rules so it never touches tracked files or node_modules.
clean-deps:
	@git clean -fX css js
