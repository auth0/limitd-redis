export CLUSTER_NO_TLS_VALIDATION=true

test-standalone-setup:
	docker-compose up -d

test-standalone-teardown:
	docker-compose down

test-cluster-setup:
	docker-compose -f docker-compose-cluster.yml up -d
	timeout 60s sh -c 'until ! docker ps | grep limitd-redis-redis-cluster-create; do echo "Waiting for cluster create container to finish..."; sleep 2; done'

test-cluster-teardown:
	docker-compose -f docker-compose-cluster.yml down

test-cluster:
	npm run test-cluster
test-standalone:
	npm run test-standalone

test: test-standalone test-cluster
test-setup: test-standalone-setup test-cluster-setup
test-teardown: test-standalone-teardown test-cluster-teardown