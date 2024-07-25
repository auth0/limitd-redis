node_1_ip="0.0.0.0"
node_2_ip="0.0.0.0"
node_3_ip="0.0.0.0"

redis-cli --cluster create $node_1_ip:16371 $node_2_ip:16372 $node_3_ip:16373 --cluster-replicas 0 --cluster-yes
echo "Waiting for cluster status to be ok..."
timeout 60s sh -c 'until redis-cli -p 16371 -c cluster info | grep cluster_state:ok ; do echo "Waiting for cluster create container to finish..."; sleep 1; done'