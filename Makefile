export CLUSTER_NO_TLS_VALIDATION=true
.ONESHELL:

VALKEY_DOCKER_IMAGE=a0us-docker.jfrog.io/bitnami/valkey:8.0.2-debian-12-r5
REDIS_DOCKER_IMAGE=a0us-docker.jfrog.io/redis:6

test: test-redis test-valkey
	@echo "All tests executed"

test-%: test-setup-% test-standalone-run test-cluster-run test-teardown-%
	@echo "Test executed"

test-setup-%: test-standalone-%-setup test-cluster-%-setup
	@echo "Test setup executed"

test-teardown-%: test-standalone-%-teardown test-cluster-%-teardown
	@echo "Test teardown executed"


test-standalone-redis-setup:
	REDIS_IMAGE=${REDIS_DOCKER_IMAGE} docker compose up -d

test-standalone-valkey-setup:
	REDIS_IMAGE=${VALKEY_DOCKER_IMAGE} docker compose up -d

test-standalone-redis-teardown:
	REDIS_IMAGE=${REDIS_DOCKER_IMAGE} docker compose down

test-standalone-valkey-teardown:
	REDIS_IMAGE=${VALKEY_DOCKER_IMAGE} docker compose down

test-cluster-redis-setup:
	REDIS_IMAGE=${REDIS_DOCKER_IMAGE} docker compose -f docker-compose-cluster.yml up -d

test-cluster-valkey-setup:
	REDIS_IMAGE=${VALKEY_DOCKER_IMAGE} docker compose -f docker-compose-cluster.yml up -d

test-cluster-redis-teardown:
	REDIS_IMAGE=${REDIS_DOCKER_IMAGE} docker compose -f docker-compose-cluster.yml down

test-cluster-valkey-teardown:
	REDIS_IMAGE=${VALKEY_DOCKER_IMAGE} docker compose -f docker-compose-cluster.yml down

test-cluster-run:
	npm run test-cluster

test-standalone-run:
	npm run test-standalone

test-teardown-all: test-standalone-redis-teardown test-cluster-redis-teardown test-standalone-valkey-teardown test-cluster-valkey-teardown


