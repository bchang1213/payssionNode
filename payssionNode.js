/**
 * payssionAction.js
 */
const Promise = require('bluebird');
var util = require('../../common/util');
var logger = require('../../common/log').getLogger('webserver');
var md5 = require('blueimp-md5');
var https = require('https');
var CheckoutLogic = require('../../yyServer/logic/CheckoutLogic');
var TableEntityService = require('../../yyServer/service/TableEntityService');
var sysSettingEntity = require("../../yyServer/entity/SysSetting");
var _account;

/**
 * Retrieve sysSetting entry from database for payssion API key
 */
function getAccount() {
    console.log("**Get Account function running.**")
    if (_account) {
      return Promise.resolve(_account);
    } else {
      var tableEntityService = new TableEntityService(
          sysSettingEntity.tableName,
          sysSettingEntity.fieldColumnNameObj,
          sysSettingEntity.primaryKeyColumnIndexs
      );
      var getSysSetting = function() {
        return tableEntityService.get({MainCode: 'payssion', SubCode: 'account'});
      };
      return tableEntityService.getConnection()
        .then(getSysSetting)
        .then(function(val){
          tableEntityService.releaseConnection();
          _account = JSON.parse(val.Param);
          _account.api_key = util.simpleDecryptPassword(_account.api_key);
          _account.secret_key = util.simpleDecryptPassword(_account.secret_key);
          return Promise.resolve(_account);
        })
        .catch(function(error){
          tableEntityService.releaseConnection();
          return Promise.reject(error);
        });
    }
}

/**
 * The final function that all the above functions funnel into. This function is called in webroutes by /payssionCheckout
 * it contains 3 functions inside of it, which are then called asynchronously at the very end using .then() syntax.
 * @param req
 * @param res
 */
function payssionCheckout(req,res){
    util.validateSubmitTimestamp(req.session, 'checkout', req.query.submitTimestamp);
    req.session.cartId = req.query.cartId;
    req.session.productId = req.query.productId;
    //store the req.query data inside this variable pm_id
    var pm_id = req.query.pm_id;
    //These parameters are a part of the request.query data passed through the http request. I have to escort this data to CheckoutFinishIndex so that
    //the user's purchase is properly processed by the system.
    var urlParameters = {
        input_code: "",
        checkoutType: req.query.checkoutType,
        cartId: req.query.cartId,
        agree: 1,
        planId:"",
        productId: req.query.productId,
        amount: req.query.amount,
        submitToken:"",
        paidAmount: req.query.paidAmount,
        hasCoupon: parseInt(req.query.hasCoupon, 10),
        submitTimestamp: req.query.submitTimestamp,
        timestamp: req.query.timestamp,
        encryptPassword : req.query.encryptPassword,
    }

    var baseURL = util.getBaseUrl(req);
    var redirecturl = util.stringifyUrl(baseURL + "/payssionPaymentSuccess", urlParameters);
    console.log("Here is the base URL: " + baseURL);
    console.log("Here is the whole redirecturl for after payment: " + redirecturl);

    //This function creates the hosted payment page request signature (api_sig value) for the payssion POST method.
    var generatePayssionAPISignature = function(_account){
        console.log("**api sig function running.**")
        var account_info = _account;
        var api_key = _account.api_key;
        //change payment_id to equal pm_id.
        //payment_id = 'sofort' when in qa or local.
        var payment_id = pm_id;
        var amount = req.query.paidAmount;
        var currency = "USD";
        var order_id = req.query.cartId;
        var secret_key = _account.secret_key;
        //concatenate a pipe after every variable, in accordance with https://payssion.com/en/docs/#api-reference-signature
        var api_sig_unhashed = api_key + "|" + payment_id + "|" + amount + "|" + currency + "|" + order_id + "|" + secret_key;
        console.log("Here is the unhashed api_sig: " + api_sig_unhashed);
        var api_sig_hashed = md5(api_sig_unhashed);
        console.log("Here is the hashed api_sig: " + api_sig_hashed)
        account_info.api_sig = api_sig_hashed;
        return account_info;
    }
    //This function will post data to the Payssion API and then direct the user to the Payssion page to collect payment.
    function postToPayssion(account_info){
        console.log("**post to payssion function running.**")
        //Live: POST https://www.payssion.com/api/v1/payment/create
        //Sandbox: POST http://sandbox.payssion.com/api/v1/payment/create

        //Declare the actual data to be posted to the URL.
        var postData = JSON.stringify({
            "api_key":account_info.api_key,
            "pm_id":pm_id,
            "api_sig":account_info.api_sig,
            "order_id":req.query.cartId,
            "description":"Payssion Sale for userID: " + req.session.user.ID + ", and email: " + req.session.user.Email,
            "return_url":redirecturl,
            "amount": req.query.paidAmount,
            "currency":"USD",
        });

        //declare the HTTPS options to enact the POST request.
        // append this to the path when in production: account_info.api_key
        var options = {
            hostname: 'payssion.com',
            port: 443,
            path: '/api/v1/payment/create',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': postData.length                
            }
        };


        //return a Promise object to run and process the HTTPS Post request.
        return new Promise(function(resolve, reject){
            var req = https.request(options, function(res){
                console.log("PAYSSION POST STATUS: " + res.statusCode);
                console.log("PAYSSION POST HEADERS: " + JSON.stringify(res.headers));
                console.log("PAYSSION RESPONSE: " + res);
                var data = '';
                res.setEncoding('utf8');
                res.on('data', function(d){
                    data = data + d.toString();
                }).on('end', function(){
                    if ((res.statusCode != 201 && res.statusCode != 200) || data.error) {
                        var err = {
                            method: "postToPayssion"
                        };
                        if (res.statusCode != 201 && res.statusCode != 200) {
                            err.statusCode = res.statusCode;
                            err.statusMessage = res.statusMessage;
                        }
                        else {
                            err.errMessage = data.error;
                        }
                        reject(JSON.stringify(err));
                    }
                    else {
                        resolve(data);
                    }
                });
            });
            req.write(postData);
            console.log("HERE IS THE PAYSSION REQUEST AFTER FINISH: " + req);
            req.end();
        });
    }
    //this function receives the resolved data from the function postToPayssion().
    /*An example of the resolved data is like thus: 
    
                {
                    "todo":"redirect",
                    "redirect_url":"http:\/\/sandbox.payssion.com\/pay\/I621252174523003",
                    "transaction":{
                        "transaction_id":"I621252174523003",
                        "state":"pending",
                        "amount":"499.00",
                        "currency":"USD",
                        "pm_id":"sofort",
                        "pm_name":"sofort",
                        "order_id":"13304",
                        "amount_local":"444.23",
                        "currency_local":"EUR"
                    },
                    "result_code":200
                }
    */
    function redirectToPayssionPaymentPage(resolvedData){
        var receivedData = resolvedData;
        console.log("Attempting to redirect. Here is the resolved data: " + receivedData);
        console.log("Here is the type of the receivedData variable: " + receivedData);

        //turn receivedData into a JSON
        var receivedJson = JSON.parse(receivedData);
        console.log("Here is the receivedJson variable value: " + receivedJson);
        console.log("Here is the receivedJson type: " + typeof receivedJson);
        //save the transaction id for use in the payment success area
        req.session.transaction_id = receivedJson.transaction.transaction_id;
        var redirectURL = receivedJson.redirect_url;
        console.log("Here is the redirect URL: " + redirectURL);

        res.status(301).redirect(redirectURL);
    }

    getAccount()
    .then(generatePayssionAPISignature)
    .then(postToPayssion)
    .then(redirectToPayssionPaymentPage)
    .catch(function(error){
        logger.error(error, 'payssionAction.payssionCheckout');
        req.session.resultDescription = error;
        console.log("payssionAction:132, Attempting to checkout with Payssion caused an error.")
        console.log("Here is the error: " + error);
    });
}


//THIS FUNCTION IS THE LAST FUNCTION TO BE RAN.
//After making a 301 redirect to the designated Payssion Payment page and the payment is made successfully,
//This function will be the next to run, enacting all of the back-end user-oriented purchase action. It will
//then redirect the user to checkoutFinishIndex route, and then after that, back to home.
/**
 * /payssionResponse
 * @param req
 * @param res
 */
function payssionPaymentSuccess(req,res){
    function createAPISig(_account){
        var account_info = _account;
        var api_key = _account.api_key;
        var secret_key = _account.secret_key;
        var transaction_id = req.session.transaction_id;
        var order_id = req.query.cartId;

        var api_sig_unhashed = api_key + "|" + transaction_id + "|" + order_id + "|" + secret_key;
        var api_sig_hashed = md5(api_sig_unhashed);
        account_info.api_sig = api_sig_hashed;
        return account_info;
    }

    //This function will post data to the Payssion API and then direct the user to the Payssion page to collect payment.
    function getPaymentDetails(account_info){
        //Live: POST https://www.payssion.com/api/v1/payment/create
        //Sandbox: POST http://sandbox.payssion.com/api/v1/payment/create

        //Declare the actual data to be posted to the URL.
        var postData = JSON.stringify({
            "api_key":account_info.api_key,
            "api_sig":account_info.api_sig,
            "order_id":req.query.cartId,
            "transaction_id": req.session.transaction_id
        });

        //declare the HTTPS options to enact the POST request.
        // append this to the path when in production: account_info.api_key
        var options = {
            hostname: 'payssion.com',
            port: 443,
            path: '/api/v1/payment/details',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': postData.length                
            }
        };

        //return a Promise object to run and process the HTTPS Post request.
        return new Promise(function(resolve, reject){
            var req = https.request(options, function(res){
                console.log("PAYSSION POST STATUS: " + res.statusCode);
                console.log("PAYSSION POST HEADERS: " + JSON.stringify(res.headers));
                console.log("PAYSSION RESPONSE: " + res);
                var data = '';
                res.setEncoding('utf8');
                res.on('data', function(d){
                    data = data + d.toString();
                }).on('end', function(){
                    if ((res.statusCode != 201 && res.statusCode != 200) || data.error) {
                        var err = {
                            method: "getPayssionPaymentDetails"
                        };
                        if (res.statusCode != 201 && res.statusCode != 200) {
                            err.statusCode = res.statusCode;
                            err.statusMessage = res.statusMessage;
                        }
                        else {
                            err.errMessage = data.error;
                        }
                        reject(JSON.stringify(err));
                    }
                    else {
                        resolve(data);
                    }
                });
            });
            req.write(postData);
            console.log("HERE IS THE PAYSSION REQUEST AFTER FINISH: " + req);
            req.end();
        });
    }

    var checkoutSuccess = function(resolvedData){
        //pass in the information of the parameter resolvedData into the ResultDescription inside param.

        var checkoutLogic = new CheckoutLogic();
        /*
        Payment Method: 7 for Payssion.
        */
        var param = {
            Flag: 1,
            userId: req.session.user.ID,
            cartId: req.session.cartId,
            productId: req.session.productId,
            amount: req.query.amount[0],
            paidAmount: req.query.paidAmount,
            hasCoupon: parseInt(req.query.hasCoupon, 10),
            ResultDescription: resolvedData,
            paymentMethod: '7',
            couponCode: req.query.hasCoupon == "1" ? req.query.couponCode : ""
        };
        console.log("Running checkout Logic Checkout Success!");
        return checkoutLogic.checkoutSuccess(param);
    };
      
    var sendCheckoutEmail = function(result){
        req.session.orderId = result.orderId;
        var param = {
            FirstName: req.session.user.FirstName,
            Email: req.session.user.Email,
            amount: req.query.paidAmount,
            productId: req.session.productId,
            orderId: result.orderId,
            baseUrl: util.getBaseUrl(req)
        };
        var checkoutLogic = new CheckoutLogic();
        return checkoutLogic.sendCheckoutEmail(param);
    };
      
    var checkoutFinish = function(){
        req.session.user.RoleType = 4;
        req.session.user.IsFreeUser = false;
        req.session.user.IsLegacyActiveUserWithoutPaying = false;
        req.session.user.IsLegacyExpiredUser = false;
        req.session.user.IsLegacyFreeUser = false;
        if(!req.session.user.UID||req.session.user.URoleType==9) {
            req.session.user.IsPayingUser= true;
        }else {
            req.session.user.IsPayingUser = false;
        }
        if((req.session.user.URoleType==4||req.session.user.URoleType==5||req.session.user.URoleType==13) &&
            req.session.user.UID) {
            req.session.user.IsLegacyPayingUser = true;
        }else {
            req.session.user.IsLegacyPayingUser = false;
        }
    
        var param = {
          userId: req.session.user.ID,
          email: req.session.user.Email,
          type: "Payssion",
          amount: req.query.paidAmount,
          orderId: req.session.orderId,
          productIds: req.session.productId,
          url: '/home'
        };
        
        req.session.orderId = null;
        req.session.cartId = null;
        req.session.productId = null;
        req.session.resultDescription = null;
        
        var url = util.stringifyUrl('/checkoutFinishIndex', param);
        res.redirect(url);
    };
      
    getAccount()
        .then(createAPISig)
        .then(getPaymentDetails)
        .then(checkoutSuccess)
        .then(sendCheckoutEmail)
        .then(checkoutFinish)
        .catch(function(err){
            logger.error(err, 'payssionAction.payssionPaymentSuccess');
            req.session.resultDescription = err;
            return "An error occurred while trying to perform the Checkout Success actions. Here are the errors: " + err;
        });
}

module.exports.payssionCheckout = payssionCheckout;
module.exports.payssionPaymentSuccess = payssionPaymentSuccess;