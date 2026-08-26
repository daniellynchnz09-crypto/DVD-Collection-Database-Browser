This project is an online database that with a UI that will present all of the movies that I have on physical media so that when I go and buy some new DVDs/Blu-rays I will know what I have and what I do not have so I don't end up buying two of the same DVD. The application is not expressly built to cater to that purpose but it will be one of the most common things that I will use the platform for.



This document is the first document of many that will inform the design of this application, in the folder Claude which is in the same folder as this Claude.md, you will find other plans for different aspects of the design as well as other resources that you can use to track data and use as guides and examples. You are free to modify these documents as you wish in order to fulfil the latest ideas for the design and add additions and specifications for the designs as they become more complicated and specialized. The only files have a strict no modification policy are the existing definitions in the Definitions file (but more definitions can be added).



**CONTEXT:**

I have a large Movie Physical media collection with multiple shelves and media formats, from DVDs, Blu-Rays, 4K UHD Blu Rays, VHS, CD Movies and more. I Currently have a google sheets spreadsheet that contains information such as title, format, disk count, special features, part of a collection, franchise, genre, Studio, disk region etc. for a large majority of my physical media collection, but not all of it.



**DELIVERABLES:**

1. Google Spreadsheet Automation
2. A Database of my collection
3. A Graphical Interface that displays my collection

   1. Has a search function
   2. Is available on web and as an app for my phone



**FILE ORGANIZATION:**

Ensure that the organization of created files is tidy and does not clutter up and of the workspaces. Screenshots that are taken should be put into their own folder and not left on the main directory for example.



**GITHUB:**

There are two versions of this program that will be uploaded to the GitHub, a public build and a private build. the two builds are basically identical except for the public build will only have a few entries in the database: Specifically the entirety of the Friends TV show to demonstrate the TV features, and all the x-men titles, Star Wars titles and my Film Noir Boxset to demonstrate the features for franchises, collections and into connected characters and actors within the web app database. The public database will also disclude any of the potential letterboxd features and will not feature real names on the taste profiles for users for the sake of privacy. The private GitHub will contain the entire build and include the whole collection database and will have real names on the taste profiles etc. This version will be used as a part to host the web app on some platform like Vercel, where it can be deployed without a domain so that those with the link can access it, but it will not appear on any search engines. And some other platform or some sort of download package will need to be made at some point, where I would be able to access it on my phone to scan things and add them to the database, preferably early? I'm still not sure how that part of the process is going to work. After each change to the program (excluding the changes to this Claude.md and other .mds in the Claude file), the each version of the program (the public and private version) will be uploaded to the github



**ASK QUESTIONS:**

If there are any potential configurations or details in these documents that don't sound right or you are confused about, let me know and I can answer those questions, if you need access to any resources that you can't access yourself, let me know and I can get those for you. Like for example, there are some API keys that I know will be necessary for the creation of this program that I have not listed anywhere in these planning documents that you will have to ask me for and store when the time comes. If there are any changes with the plan, update these documents while keeping the original plan in some sort of backlog. That way future sessions will be able to see the current plan and look back on the original plan if necessary



**ENSURE STABLITY AND SECURITY**

When Building these applications, ensure that builds are both stable and secure, ensure that people who may get access to code from the GitHub cannot get access to secrets or personally identifiable information (this may be unavoidable to not disclude this data on the private version, but perhaps that data could be encrypted or something?) there should be protections in place to prevent outside actors from spamming links to cause attacks or get access to pages that they should not have access to. On the automation front I would like automations to be able run at a usable speed and reduce unnecessary redundancy where possible. Once the program is complete I will likely run stability, efficiency and security tests on the software to see how it holds up

