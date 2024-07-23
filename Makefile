export CLUSTER_NO_TLS_VALIDATION=true

test-setup:
	docker-compose up -d

test-teardown:
	docker-compose down

test-cluster-setup:
	docker-compose -f docker-compose-cluster.yml up -d --wait

test-cluster-teardown:
	docker-compose -f docker-compose-cluster.yml down

test-run:
	@echo "Running tests..."
	npm run test

test-cluster:
	npm run test-cluster
test-standalone:
	npm run test-standalone
test: test-standalone test-cluster