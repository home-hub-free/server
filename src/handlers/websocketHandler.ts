import { Server } from "socket.io";
import http from "http";
export let io;

export function initWebSockets(server: http.Server) {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on('connect', () => {
    console.log('new connection');
  });

  io.on('disconnect', () => {
    console.log('disconnection');
  })
}
