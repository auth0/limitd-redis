node_1_ip="0.0.0.0"
node_2_ip="0.0.0.0"
node_3_ip="0.0.0.0"

redis-cli --cluster create $node_1_ip:16371 $node_2_ip:16372 $node_3_ip:16373 --cluster-replicas 0 --cluster-yes