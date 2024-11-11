const { exec } = require('child_process');
const { getsockopt } = require('sockopt');

const getSockOptValue = (socket, opt, cb) => {
  if (process.env.CI !== undefined) {
    return linuxGetSockOptValue(socket, opt, cb);
  }

  return macosGetSockOptValue(socket, opt, cb);
};

const macosGetSockOptValue = (socket, opt, cb) => {
  const pid = process.pid;
  exec(`lsof -a -p ${pid} -i 4 -T f`, (error, stdout, stderr) => {
    if (error) {
      return cb(error);
    }
    if (stderr) {
      return cb(new Error(stderr));
    }

    const keepAliveOption = stdout
      .split('\n')
      .find(line => line.includes(`:${socket.localPort}`) && line.includes(`:${socket.remotePort}`));

    if (!keepAliveOption) {
      cb(new Error(`no entry found for local port ${socket.localPort}, and remote port ${socket.remotePort}`));
    }

    if (!keepAliveOption.includes(opt)) {
      cb(new Error(`${opt} option not found: ${keepAliveOption}`));
    }

    const keepAliveValue = parseInt(keepAliveOption.match(new RegExp(`${opt}=(\\d+)`))[1], 10);
    cb(null, keepAliveValue);
  });
};

const linuxGetSockOptValue = (socket, opt, cb) => {
  const SOL_SOCKET = 0xffff;
  const SOCK_OPTS = {
    'SO=KEEPALIVE': 0x0008,
  };
  if (!SOCK_OPTS[opt]) {
    return cb(new Error(`Unknown socket option: ${opt}`));
  }

  const keepAliveValue = getsockopt(socket, SOL_SOCKET, SOCK_OPTS[opt]);
  cb(null, keepAliveValue);
};

module.exports = {
  getSockOptValue
};
