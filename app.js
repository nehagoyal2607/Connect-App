const express = require("express");
const app = express();
const dotenv = require('dotenv');
const PubNub = require("pubnub");
const bodyParser = require('body-parser');
const twilio = require('twilio');
const WebSocket = require('ws');
const ser = require("http").createServer(app);
const reqt = require('request');
const session = require("express-session");
const LocalStrategy = require("passport-local");
const mongoose = require("mongoose");
const passport = require("passport")
const User = require("./models/user.js");

const server = app.listen(process.env.PORT || 3000, () => {
  console.log('listening on *:3000');
});

mongoose.connect('mongodb+srv://neha:NehaGoyal%40123@cluster0.vqfk9.mongodb.net/twiliocall?retryWrites=true&w=majority', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('Connected to DB!'))
.catch(error => console.log(error.message));

const wss = new WebSocket.Server({ server });
const speech = require("@google-cloud/speech");
const req = require("express/lib/request");
const speechClient = new speech.SpeechClient();
let call_sid;
let intro_msg;
let call_type;
//Configure Transcription Request
const request = {
  config: {
    encoding: "MULAW",
    sampleRateHertz: 8000,
    languageCode: "en-GB"
  },
  interimResults: false
};

const io = require('socket.io')(server);
dotenv.config();
const pubnub = new PubNub({
    publishKey: process.env.PUBLISH_KEY,
    subscribeKey: process.env.SUBSCRIBE_KEY,
    uuid: PubNub.generateUUID(),
  });


const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = require('twilio')(accountSid, authToken);
const VoiceResponse = require('twilio').twiml.VoiceResponse;


app.set("view engine","ejs");
app.use(bodyParser.urlencoded({extended:true}));
app.use(express.static(__dirname+"/public"));
app.use(express.json())

app.use(session({
	secret:"Twilio Call",
	resave:false,
	saveUninitialized:false
}));
app.use(passport.initialize());
app.use(passport.session());
passport.use(new LocalStrategy(User.authenticate()));
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

app.use(function(req,res,next){
	res.locals.currentUser = req.user;
	next();
})

const isLoggedIn = function(req,res,next){
	if(!req.user){
		res.redirect('/login');
	}else{
		next();
	}
}
wss.on("connection", function connection(ws) {
  console.log("New Connection Initiated");
    let recognizeStream = null;

     ws.on("message", function incoming(message) {
      const msg = JSON.parse(message);
      
      switch (msg.event) {
        case "connected":
          console.log(`A new call has connected.`);
          recognizeStream = speechClient
          .streamingRecognize(request)
          .on("error", console.error)
          .on("data", data => {
            console.log(data.results[0].alternatives[0].transcript);
            wss.clients.forEach( client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(
                    JSON.stringify({
                    event: "interim-transcription",
                    text: data.results[0].alternatives[0].transcript
                  })
                );
              }
            });

          });

          break;
        case "start":
          console.log(`Starting Media Stream ${msg.streamSid}`);
          break;
        case "media":
          recognizeStream.write(msg.media.payload);
          break;
        case "stop":
          console.log(`Call Has Ended`);
          recognizeStream.destroy();
          break;
        case "tospeech":
          console.log(msg.text);
          const response = new VoiceResponse();
          response.say({ voice: 'alice' }, msg.text)
          const connect = response.connect();
          connect.stream({
              url: 'wss://connect-webapp.herokuapp.com/'
          });
          
          l = client.calls.get(call_sid)
          l.update({twiml:String(response)})
          break;
      }
    });
  
  });


app.get('/', (req, res) => {
  res.render('home.ejs');
});


app.get('/login', (req, res) => {
  res.render('login.ejs');
});

app.post("/login",passport.authenticate("local",{
  failureRedirect:"/home"
}),(req,res) => {
  console.log("Successfully Logged in");
      res.redirect("/main");
});

app.get('/register', (req, res) => {
  res.render('register.ejs');
});
app.post("/register",(req,res) => {
	  
	let newUser = new User({username:req.body.username, email:req.body.email, recent:[]});
	User.register(newUser, req.body.password, (err,user) => {
		if(err){
			console.log(err);
			return res.redirect("back")
		}

		  passport.authenticate("local")(req,res,() => {
        console.log("Successfully Logged in");
			  res.redirect("/main");
		})
	})
})

//LOGOUT ROUTES
app.get("/logout",(req,res) => {
	req.logout();
	res.redirect("/home");
})

app.get('/restaurant', isLoggedIn, (req, res) => {
  call_type = "Restaurant";
  res.render('form.ejs');
});
app.get('/home', (req, res) => {
  res.render('home.ejs');
});
app.get('/pharmacy', isLoggedIn, (req, res) => {
  call_type = "Pharmacy";
  res.render('pharmacy.ejs');
});
app.get('/main', isLoggedIn, (req, res) => {
  res.render('main.ejs');
});
app.get("/chat", (req,res)=>{
  res.render("chat.ejs", {intro_msg:intro_msg, call_type:call_type});
})


app.get('/emergen', (req, res) => {
  call_type = "Emergency";
  reqt('https://api.geoapify.com/v1/ipinfo?&apiKey='+process.env.GEO_APIKEY, { json: true }, (err, res, body) => {
    if (err) { return console.log(err); }
  
    intro_msg = `Hi, I am using an assistive calling app. I am calling from ${body.city.name}. I am in an emergency. My exact coordinates are Latitude - ${body.location.latitude}, Longitude - ${body.location.longitude}.`
    console.log(intro_msg);
  });

  res.header('Content-Type', 'Authorization');
  client.calls
  .create({
     url: ' https://connect-webapp.herokuapp.com/call',
     from: '+19563046910',
     to: '+919811881273'
   })
  .then(call => {
    if(req.user){
      User.findById(req.user._id, function(err, user){
        if(err){
          console.log(err);
        }else{
          var newcall = {receiver:req.body.rph, date: new Date(), call_type:call_type};
          user.recent.push(newcall);
          user.save()
        
        }})
    }
    call_sid = call.sid;
    console.log(client.calls.get(call.sid))
    res.redirect("/chat");
  });

  res.type('text/xml');
  // res.render('emergen.ejs', {apikey : process.env.GOOGLE_GEOLOCATION_APIKEY});
});


app.post('/opencall', (req, res)=>{
  // console.log(req.body);
  console.log("call started");
  intro_msg = `Hi, I am using an assistive calling app. `
  intro_msg += req.body.finaldata?req.body.finaldata:"";
  console.log(req.headers.host);
  res.header('Content-Type', 'Authorization');
  client.calls
  .create({
     url: ' https://connect-webapp.herokuapp.com/call',
     from: req.body.mph || '+19563046910',
     to: req.body.rph || '+919811881273'
   })
  .then(call => {
    if(req.user){
      User.findById(req.user._id, function(err, user){
        if(err){
          console.log(err);
        }else{
          var newcall = {receiver:req.body.rph, date: new Date(), call_type:call_type};
          user.recent.push(newcall);
          user.save()
        
        }})
    }
    call_sid = call.sid;
    console.log(client.calls.get(call.sid))
    res.redirect("/chat");
  });
  
  res.type('text/xml');
})


app.post('/call', (req, res)=>{
  call_type = "General Call"
  res.set("Content-Type", "text/xml");
  console.log("hi3");
  const response = new VoiceResponse();
  response.say({ voice: 'alice' }, intro_msg)
  const connect = response.connect();
  connect.stream({
      url: 'wss://connect-webapp.herokuapp.com/'
  });
  res.type('text/xml');
  res.send(response.toString());

})


// const port = process.env.PORT || 3000
// app.listen(port, process.env.IP, function(){
// 	console.log("App is running.");
// })