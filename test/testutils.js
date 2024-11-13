const { exec } = require('child_process');
const os = require('os');
const assert = require('chai').assert;

// Linux-specific functions
const dropPacketsLinux = (remoteIp) => {
  exec(`sudo iptables -A OUTPUT -d ${remoteIp} -j DROP`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error dropping packets: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`stderr: ${stderr}`);
      return;
    }
    console.log(`Packets to ${remoteIp} dropped`);
  });
};

const restorePacketsLinux = (remoteIp) => {
  exec(`sudo iptables -D OUTPUT -d ${remoteIp} -j DROP`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error restoring packets: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`stderr: ${stderr}`);
      return;
    }
    console.log(`Packets to ${remoteIp} restored`);
  });
};

// macOS-specific functions
const dropPacketsMacOS = (remoteIp) => {
  const pfRule = `block drop out from any to ${remoteIp}`;
  exec(`echo "${pfRule}" | sudo pfctl -ef -`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error dropping packets: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`stderr: ${stderr}`);
      return;
    }
    console.log(`Packets to ${remoteIp} dropped`);
  });
};

const restorePacketsMacOS = (remoteIp) => {
  exec(`sudo pfctl -F all -f /etc/pf.conf`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error restoring packets: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`stderr: ${stderr}`);
      return;
    }
    console.log(`Packets to ${remoteIp} restored`);
  });
};

// Main functions
const dropPackets = (remoteIp) => {
  if (os.platform() === 'linux') {
    dropPacketsLinux(remoteIp);
  } else if (os.platform() === 'darwin') {
    dropPacketsMacOS(remoteIp);
  } else {
    console.error('Unsupported OS');
  }
};

const restorePackets = (remoteIp) => {
  if (os.platform() === 'linux') {
    restorePacketsLinux(remoteIp);
  } else if (os.platform() === 'darwin') {
    restorePacketsMacOS(remoteIp);
  } else {
    console.error('Unsupported OS');
  }
};

const assertIsNear = (actual, expected, delta) => {
  assert.isAtLeast(actual, expected - delta, `Expected ${actual} to be at least ${expected - delta}`);
  assert.isAtMost(actual, expected + delta, `Expected ${actual} to be at most ${expected + delta}`);
}

module.exports = {
  dropPackets,
  restorePackets,
  assertIsNear
}

// // Example usage
// const remoteRedisIp = '192.168.1.100';
// dropPackets(remoteRedisIp);
//
// // Wait for 5 seconds before restoring packet flow
// setTimeout(() => {
//   restorePackets(remoteRedisIp);
// }, 5000);



// const getSockOptValue = (socket, opt, cb) => {
//   // if (process.env.CI !== undefined) {
//   //   return linuxGetSockOptValue(socket, opt, cb);
//   // }
//   //
//   // return macosGetSockOptValue(socket, opt, cb);
//   cb(NetKeepAlive.getKeepAliveInterval(socket));
// };
//
// const macosGetSockOptValue = (socket, opt, cb) => {
//   const pid = process.pid;
//   exec(`lsof -a -p ${pid} -i 4 -T f`, (error, stdout, stderr) => {
//     if (error) {
//       return cb(error);
//     }
//     if (stderr) {
//       return cb(new Error(stderr));
//     }
//
//     const keepAliveOption = stdout
//       .split('\n')
//       .find(line => line.includes(`:${socket.localPort}`) && line.includes(`:${socket.remotePort}`));
//
//     if (!keepAliveOption) {
//       cb(new Error(`no entry found for local port ${socket.localPort}, and remote port ${socket.remotePort}`));
//     }
//
//     if (!keepAliveOption.includes(opt)) {
//       cb(new Error(`${opt} option not found: ${keepAliveOption}`));
//     }
//
//     const keepAliveValue = parseInt(keepAliveOption.match(new RegExp(`${opt}=(\\d+)`))[1], 10);
//     cb(null, keepAliveValue);
//   });
// };
//
// const linuxGetSockOptValue = (socket, opt, cb) => {
//   const SOL_SOCKET = 0xffff;
//   const SOCK_OPTS = {
//     'SO=KEEPALIVE': 0x0008,
//   };
//   if (!SOCK_OPTS[opt]) {
//     return cb(new Error(`Unknown socket option: ${opt}`));
//   }
//
//   const keepAliveValue = getsockopt(socket, SOL_SOCKET, SOCK_OPTS[opt]);
//   cb(null, keepAliveValue);
// };
//
// module.exports = {
//   getSockOptValue
// };
//
//
//
// const { exec } = require('child_process');
