export CLUSTER_NO_TLS_VALIDATION=true

test-standalone-setup:
	docker compose up -d

test-standalone-teardown:
	docker compose down

test-cluster-setup:
	docker compose -f docker-compose-cluster.yml up -d

test-cluster-teardown:
	docker compose -f docker-compose-cluster.yml down

test-cluster:
	npm run test-cluster
test-standalone:
	npm run test-standalone

test: test-standalone test-cluster
test-setup: test-standalone-setup test-cluster-setup
test-teardown: test-standalone-teardown test-cluster-teardown