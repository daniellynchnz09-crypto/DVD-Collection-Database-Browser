**STEP BY STEP PROCESS AND AUTOMATIONS**



SETUP:

1. The google sheet data is going to have to be copied into some sort of SQL data base that's also being updated along with the google sheet early on because there's no way that we are going to be able to run the web app off a google sheets document without major performance issues. This database will have to take priority of the google sheets document in terms of processing time.
2. Add more setup steps if the needs arise



BARCODE SCANNING: (barely defined as I have no idea how to do this part)

[Now concretely designed as part of Phase 1 - see Claude/TECH STACK AND ARCHITECTURE.md's "BARCODE SCANNING PIPELINE" section for the resolved approach: scanning is decoupled from lookup (scan queues instantly, a separate resolver looks things up against UPCitemdb + OMDB at a safe rate), collections are handled via an OMDB-assisted checklist the user confirms, and documentary chronological ordering uses a regex-inferred "depicted era" field with manual fallback. This section's original notes are kept as-is below for context.]

1. An app needs to be created for scanner part
2. Create android phone app
3. perhaps app exported as some sort of .apk to download onto my phone
4. when phone scans barcode on case it would find some place on the internet where the data is on the title??? (idk how, maybe through Blu-ray.com??)
5. If the app is unsure on which one it is and it has a few options, then it will get the user to decide which title/release it is, perhaps it shows and image and details of each title/release
6. after the title is selected or is found automatically it processes the data



UPDATING THE GOOGLE SHEET:

1. perhaps the first time it updates the google sheet ever, it might have to make a few new columns (and in the future it may have to make new columns). these being

   1. Unique Identifier (a unique identifier for each title which will help with the sql database)
   2. Some sort of barcode identifier (maybe an image or a number string or something) (This is in the case that I add a new column in the future and instead of having to scan all the barcodes again, the program can just use the barcode identifier and scan itself to retrieve this new information)
   3. An image of the title (not the poster but of the actual DVD case) (perhaps from the same place the barcode scanner got it's data)
   4. A genre location column which shows what genre the title is located in my collection. As the genre column on the spreadsheet often contains multiple genres and in my physical collection, a title can only go under one genre. So this column will list what genre that title is under in my collection. This will be used to be able to estimate approximately where the title exists in my collection.
   5. Other things (I'm sure that the program is going to need to end up making more columns in the google sheets or the SQl database in order to make future functions works but I'm not sure what they are right now but take this as a ticket to make whatever future columns are needed in the sheets)
   6. When a new column is created, all the previous titles should get that column filled in through information of some kind of reference link whether that be the barcode reference link I mentioned earlier or through imdb/omdb
   7. Also consider the fact that there might the rare case where there is a DVD in a blank case or a DVD case that has the title and barcode of one movie but the disk inside is of a completely different movie, this often specifically happens with kids movies that I find in thrift stores as sometimes kids don't put the right discs in the right case. These titles might need to be input manually via the google sheets. with n/a left in the barcode entries.
2. There is some sort of list of what the different columns in the google sheet are so the search part of the barcode scanner knows what to search for
3. The information that the search part of the barcode scanner found is stored in some cache document thingy and that is then written into the google sheets and the other better high performance database made with or whatever it will be. If there is a collection then the collection and all the titles in the collection will be written in at once.
4. If there is missing information about the title that cannot be found through the use of the barcode or the IMDB link, the program will ask the user (on the phone or wherever they scanned the title) for the missing information that could be found by looking at the case for example, the disk count or the disk region etc, which will be manually entered into the popup dialog boxes which are then added into the spreadsheet and the database. This missing information of course has boundaries like for example it wont ask the user what season the title is if the title is a movie, and will instead just put n/a. Perhaps the missing information box could act similarly to how Claude asks questions where it has a range of options you can select as well as an other option, and after you've answered that question another question appears on the next page.
5. After all the information for the title is in the google sheet and database there will be a message that appears on the scanning app that tells the user that the entry was added successfully
6. The App will use the genre location column to find where the recently scanned title is going to be located within my collection by listing the two titles that it would be in-between (titles in a genre section are listed alphabetically, excluding history documentaries, where titles are ordered by the date in which their historical events took place: Egypt before romans, Spanish civil war before the Facebook hack etc.). The program will then show a dialog box to tell the user that information.
7. The scanner part of the app will then automatically go back to the camera ready to scan another title.



STEP BY STEP PROCESS FOR ENTIRE BUILD

1. get claude to view/scan the google sheets to understand the context of how it is put together.
2. Create the other 'sql' database based on the data from the google sheet
3. Consider the other variables/column entries that may be required to make the web app function
4. Create those columns and fill in the data on all entries that don't have data for the new columns
5. Build the Barcode part of the Phone app
6. Export it so I can test it on my phone
7. Work through bugs and app design as well as test the scanner part of app.
8. Create the main header part for the web app
9. Achieve functionality for the basic search (no advanced search functions yet)
10. Create a template for all the types of title pages so that a title can be searched and clicked on and have it's details viewed without having to design the title page for each title which would be massively ineffeicent.
11. Bugfix, test and refine the design the header and title pages to my liking
12. Complete the home/browse page
13. Bugfix test and refine the design of the home/browse page
14. Implement advanced search and taste profiles
15. Bugfix test and refine the design of advanced search and taste profiles
16. Implement direct database access:
17. Bugfix test and refine the design of Direct database Access
18. Update the phone app with all the changes that have been made to the web app version
19. Ensure that changes made to the web app version and the Phone version seamlessly sync over (perhaps also create workarounds if the phone app or web app is offine and changes are made)
20. Bugfix test and refine the design of Phone app
21. Final big security and effiecency test
22. Work on Backlog tasks

