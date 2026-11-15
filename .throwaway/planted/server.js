// Planted for #42's throwaway PR: code the scan must reject. Never merged.
const { exec } = require("child_process");
const express = require("express");
const app = express();
app.get("/run", (req, res) => {
  exec("ls " + req.query.dir);
  res.send(eval(req.query.code));
});
app.get("/page", (req, res) => {
  res.send("<p>" + req.query.name + "</p>");
});
