const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

/* -----------------------------
   Middleware
------------------------------ */
app.use(cors());
app.use(express.json());

/* -----------------------------
   Health Check
------------------------------ */
app.get("/", (req, res) => {
  res.send("Redulix AI Chat Server Running ✅");
});

/* -----------------------------
   Chat API
------------------------------ */
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;

    // Simple demo response logic
    let reply = "Welcome to UrbanWear 👋";

    if (message) {
      const lower = message.toLowerCase();

      if (lower.includes("hello") || lower.includes("hi")) {
        reply =
          "Hello 👋 Welcome to UrbanWear. How can I help you today?";
      } else if (lower.includes("product")) {
        reply =
          "We offer premium streetwear, jackets, sneakers, and accessories.";
      } else if (lower.includes("price")) {
        reply =
          "Our product prices vary from $29 to $120 depending on the item.";
      } else if (lower.includes("shipping")) {
        reply =
          "We provide worldwide shipping 🚚";
      } else {
        reply =
          "Thanks for your message. Our UrbanWear assistant will help you shortly.";
      }
    }

    res.json({
      success: true,
      reply,
    });
  } catch (error) {
    console.error("Chat API Error:", error);

    res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
});

/* -----------------------------
   EMBED SCRIPT
------------------------------ */
app.get("/embed.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");

  res.send(`
(function () {

  // Prevent duplicate widget
  if (window.RedulixWidgetLoaded) return;
  window.RedulixWidgetLoaded = true;

  console.log("Redulix AI Widget Loaded ✅");

  // Create Chat Button
  const button = document.createElement("div");
  button.id = "redulix-chat-button";
  button.innerHTML = "💬";

  Object.assign(button.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    width: "65px",
    height: "65px",
    borderRadius: "50%",
    background: "#ff4757",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "28px",
    cursor: "pointer",
    zIndex: "999999",
    boxShadow: "0 8px 25px rgba(0,0,0,0.25)",
    transition: "0.3s"
  });

  button.onmouseenter = () => {
    button.style.transform = "scale(1.08)";
  };

  button.onmouseleave = () => {
    button.style.transform = "scale(1)";
  };

  document.body.appendChild(button);

  // Create Chat Window
  const chatWindow = document.createElement("div");
  chatWindow.id = "redulix-chat-window";

  Object.assign(chatWindow.style, {
    position: "fixed",
    bottom: "100px",
    right: "20px",
    width: "350px",
    height: "500px",
    background: "white",
    borderRadius: "20px",
    overflow: "hidden",
    display: "none",
    flexDirection: "column",
    zIndex: "999999",
    boxShadow: "0 10px 35px rgba(0,0,0,0.25)",
    fontFamily: "Arial, sans-serif"
  });

  chatWindow.innerHTML = \`
    <div style="
      background:#111;
      color:white;
      padding:16px;
      font-size:18px;
      font-weight:bold;
    ">
      UrbanWear Assistant
    </div>

    <div id="redulix-messages" style="
      flex:1;
      padding:15px;
      overflow-y:auto;
      background:#f7f7f7;
      height:360px;
    ">
      <div style="
        background:white;
        padding:10px 14px;
        border-radius:12px;
        margin-bottom:10px;
        max-width:80%;
        box-shadow:0 2px 6px rgba(0,0,0,0.08);
      ">
        👋 Welcome to UrbanWear! How can I help you?
      </div>
    </div>

    <div style="
      display:flex;
      border-top:1px solid #ddd;
    ">
      <input 
        id="redulix-input"
        type="text"
        placeholder="Type your message..."
        style="
          flex:1;
          border:none;
          padding:14px;
          outline:none;
          font-size:14px;
        "
      />

      <button 
        id="redulix-send"
        style="
          border:none;
          background:#ff4757;
          color:white;
          width:70px;
          cursor:pointer;
          font-weight:bold;
        "
      >
        Send
      </button>
    </div>
  \`;

  document.body.appendChild(chatWindow);

  // Toggle Chat
  button.onclick = () => {
    chatWindow.style.display =
      chatWindow.style.display === "flex"
        ? "none"
        : "flex";
  };

  // Send Message
  const sendBtn = chatWindow.querySelector("#redulix-send");
  const input = chatWindow.querySelector("#redulix-input");
  const messages = chatWindow.querySelector("#redulix-messages");

  async function sendMessage() {
    const text = input.value.trim();

    if (!text) return;

    // User Message
    const userMsg = document.createElement("div");
    userMsg.style.cssText = \`
      background:#ff4757;
      color:white;
      padding:10px 14px;
      border-radius:12px;
      margin:10px 0 10px auto;
      max-width:80%;
      width:fit-content;
    \`;
    userMsg.innerText = text;

    messages.appendChild(userMsg);
    messages.scrollTop = messages.scrollHeight;

    input.value = "";

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: text
        })
      });

      const data = await response.json();

      const botMsg = document.createElement("div");

      botMsg.style.cssText = \`
        background:white;
        padding:10px 14px;
        border-radius:12px;
        margin-bottom:10px;
        max-width:80%;
        width:fit-content;
        box-shadow:0 2px 6px rgba(0,0,0,0.08);
      \`;

      botMsg.innerText = data.reply || "No response";

      messages.appendChild(botMsg);
      messages.scrollTop = messages.scrollHeight;

    } catch (err) {
      console.error(err);

      const errorMsg = document.createElement("div");

      errorMsg.style.cssText = \`
        background:#fee2e2;
        color:#991b1b;
        padding:10px 14px;
        border-radius:12px;
        margin-bottom:10px;
        max-width:80%;
      \`;

      errorMsg.innerText =
        "Server connection failed ❌";

      messages.appendChild(errorMsg);
    }
  }

  sendBtn.addEventListener("click", sendMessage);

  input.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      sendMessage();
    }
  });

})();
  `);
});

/* -----------------------------
   Start Server
------------------------------ */
app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT} 🚀\`);
});