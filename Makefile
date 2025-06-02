export CLUSTER_NO_TLS_VALIDATION=true
.ONESHELL:

VALKEY_DOCKER_IMAGE=bitnami/valkey:8.0.2-debian-12-r5
REDIS_DOCKER_IMAGE=redis:6
.PHONY: test integration integration-% integration-setup-% integration-teardown-% integration-standalone-redis-setup integration-standalone-valkey-setup integration-standalone-redis-teardown integration-standalone-valkey-teardown integration-cluster-redis-setup integration-cluster-valkey-setup integration-cluster-redis-teardown integration-cluster-valkey-teardown integration-cluster-run integration-standalone-run integration-teardown-all

test:
	npm run test
integration: integration-redis integration-valkey
	@echo "All tests executed"

integration-%: integration-setup-% integration-standalone-run integration-cluster-run integration-teardown-%
	@echo "Test executed"

integration-setup-%: integration-standalone-%-setup integration-cluster-%-setup
	@echo "Test setup executed"

integration-teardown-%: integration-standalone-%-teardown integration-cluster-%-teardown
	@echo "Test teardown executed"

integration-standalone-redis-setup:
	REDIS_IMAGE=${REDIS_DOCKER_IMAGE} docker compose up -d

integration-standalone-valkey-setup:
	REDIS_IMAGE=${VALKEY_DOCKER_IMAGE} docker compose up -d

integration-standalone-redis-teardown:
	REDIS_IMAGE=${REDIS_DOCKER_IMAGE} docker compose down

integration-standalone-valkey-teardown:
	REDIS_IMAGE=${VALKEY_DOCKER_IMAGE} docker compose down

integration-cluster-redis-setup:
	REDIS_IMAGE=${REDIS_DOCKER_IMAGE} docker compose -f docker-compose-cluster.yml up -d

integration-cluster-valkey-setup:
	REDIS_IMAGE=${VALKEY_DOCKER_IMAGE} docker compose -f docker-compose-cluster.yml up -d

integration-cluster-redis-teardown:
	REDIS_IMAGE=${REDIS_DOCKER_IMAGE} docker compose -f docker-compose-cluster.yml down

integration-cluster-valkey-teardown:
	REDIS_IMAGE=${VALKEY_DOCKER_IMAGE} docker compose -f docker-compose-cluster.yml down

integration-cluster-run:
	npm run test-integration-cluster

integration-standalone-run:
	npm run test-integration-standalone

integration-teardown-all: integration-standalone-redis-teardown integration-cluster-redis-teardown integration-standalone-valkey-teardown integration-cluster-valkey-teardown
