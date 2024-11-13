#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <fcntl.h>
#include <errno.h>

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <file_descriptor>\n", argv[0]);
        exit(EXIT_FAILURE);
    }

    int sockfd = atoi(argv[1]);
    int optval;
    socklen_t optlen = sizeof(optval);

    // Check if the file descriptor is valid
    if (fcntl(sockfd, F_GETFD) == -1) {
        fprintf(stderr, "Invalid file descriptor: %s\n", strerror(errno));
        exit(EXIT_FAILURE);
    }

    // Check if the file descriptor is a socket
    int type;
    socklen_t length = sizeof(type);
    if (getsockopt(sockfd, SOL_SOCKET, SO_TYPE, &type, &length) == -1) {
        fprintf(stderr, "Not a socket: %s\n", strerror(errno));
        exit(EXIT_FAILURE);
    }

    printf("File descriptor: %d\n", sockfd);
    printf("SOL_SOCKET: %d\n", SOL_SOCKET);
    printf("SO_KEEPALIVE: %d\n", SO_KEEPALIVE);

    // Get the value of SO_KEEPALIVE
    if (getsockopt(sockfd, SOL_SOCKET, SO_KEEPALIVE, &optval, &optlen) < 0) {
        fprintf(stderr, "getsockopt: %s\n", strerror(errno));
        exit(EXIT_FAILURE);
    }

    printf("SO_KEEPALIVE value: %d\n", optval);
    return 0;
}
